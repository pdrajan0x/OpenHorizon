// A cooked Unreal Engine 4 level (and every level it streams in) → the game's streaming map data, in the
// same format tools/gta5conv writes (see its MapWriter.cs header): cells/<i>.bin render geometry merged per
// material per cell, col/<i>.bin collision, tex/<name>.gtx, roads.json (the map's OpenDRIVE road network,
// Xodr.cs), manifest.json.
//
// Every visible static mesh component is placed at its world transform (its attach parents' transforms
// chained, each instance of an instanced component on top). Each mesh uses the most detailed LOD within a
// triangle budget set by its size (a skyscraper keeps its detail, a bollard doesn't), and collides with
// its coarsest LOD; foliage doesn't collide. Materials: CUE4Parse's texture-slot guess for the diffuse and
// normal maps, the base material's blend mode for glass and cut-outs.
//
// Frames: Unreal is x forward, y right, z up, centimetres (left-handed); the game is x forward (north),
// y up, z right (east), metres: (X, Y, Z) → (X, Z, Y) / 100, a mirror that also makes it right-handed,
// so front faces stay front faces. Recentred on the middle of the road network.
using System.Text.Json.Nodes;
using CUE4Parse.FileProvider;
using CUE4Parse.UE4.Assets;
using CUE4Parse.UE4.Assets.Exports;
using CUE4Parse.UE4.Assets.Exports.Component;
using CUE4Parse.UE4.Assets.Exports.Component.StaticMesh;
using CUE4Parse.UE4.Assets.Exports.Material;
using CUE4Parse.UE4.Assets.Exports.StaticMesh;
using CUE4Parse.UE4.Assets.Exports.Texture;
using CUE4Parse.UE4.Objects.Core.Math;
using CUE4Parse.UE4.Objects.Engine;
using CUE4Parse.UE4.Objects.UObject;
using CUE4Parse.UE4.Assets.Objects;
using CUE4Parse_Conversion.Textures;
using CUE4Parse.UE4.Objects.RenderCore;

static class UeMap
{
    const float CellSize = 250;
    const int MaxTex = 1024;
    const float DetailRadius = 8; // m: smaller meshes are detail (distance-culled in the game)
    const long PerMesh = 500_000; // triangles of one mesh over all its copies, at the LOD chosen
    const long PerMeshMax = 1_000_000; // …and if even its lightest LOD is over this, only some copies are placed
    // Collision: driving surfaces exactly (their coarsest LOD); anything else solid as its oriented box
    // (12 triangles: a building, a pole, a bin); road markings, decals and foliage not at all
    static readonly string[] DriveWords = ["road", "ground", "terrain", "landscape", "sidewalk", "curb", "kerb", "bridge", "tunnel", "ramp", "parking", "plaza", "street", "highway", "stair", "floor"];
    static readonly string[] NoCollideWords = ["marking", "decal", "stripe", "paint", "crosswalk", "puddle", "leak", "trash_", "banner", "wire", "cable"];
    const float Crop = 600; // m: cells farther than this from every road are left out (backdrop sea and sand planes)
    const float SeaLevel = -2.5f; // m: the towns are built at 0 with no sea; ours goes this far below their ground
    // Sublevels that hold no scenery (lighting, weather, particles) or things that move (parked cars)
    static readonly string[] SkipLevels = ["Weather", "Rendering_and_Lighting", "Particles", "Parked_Vehicles", "_Day", "_Night", "_Sunset"];
    static readonly string[] FoliageWords = ["foliage", "vegetation", "tree", "bush", "plant", "grass", "hedge", "shrub", "ivy", "flower", "leaf", "leaves"];

    class Batch { public readonly List<float> Pos = [], Nrm = [], Uv = []; public readonly List<uint> Idx = []; public bool Detail; }
    class Mat { public int Index; public string Shader = "", Diffuse, Normal; public bool Blend, Mask, Water; }
    class Mesh
    {
        public float[] Pos, Nrm, Uv; // local, Unreal frame
        public uint[] Idx;
        public (int mat, int first, int count)[] Sections;
        public Mat[] Mats;
        public float[] ColPos; // coarsest LOD, for collision
        public uint[] ColIdx;
        public float Radius; // m
        public bool Foliage;
        public long Triangles;
        public string Name;
        public double Keep = 1; // share of its copies placed
        public bool Drive, NoCollide; // collides exactly (a driving surface); doesn't collide at all
        public float[] Min, Max; // local bounds, Unreal frame (cm)
    }

    // A box's 12 triangles over corners k = x | y << 1 | z << 2 (Unreal winding, faces outward)
    static readonly uint[] BoxIndex = [0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6, 0, 1, 4, 1, 5, 4, 2, 6, 3, 3, 6, 7, 0, 4, 2, 2, 4, 6, 1, 3, 5, 3, 7, 5];

    // ---- 4×4 matrices, row vectors (v' = v · M), as Unreal's FMatrix ----
    static double[] Mat4(FTransform t)
    {
        var m = t.ToMatrixWithScale();
        return [m.M00, m.M01, m.M02, m.M03, m.M10, m.M11, m.M12, m.M13, m.M20, m.M21, m.M22, m.M23, m.M30, m.M31, m.M32, m.M33];
    }
    static double[] Mul(double[] a, double[] b)
    {
        var r = new double[16];
        for (int i = 0; i < 4; i++)
            for (int j = 0; j < 4; j++)
                r[i * 4 + j] = a[i * 4] * b[j] + a[i * 4 + 1] * b[4 + j] + a[i * 4 + 2] * b[8 + j] + a[i * 4 + 3] * b[12 + j];
        return r;
    }

    public static void Write(DefaultFileProvider p, string rootLevel, string xodr, string outDir)
    {
        Directory.CreateDirectory(Path.Combine(outDir, "cells"));
        Directory.CreateDirectory(Path.Combine(outDir, "col"));
        Directory.CreateDirectory(Path.Combine(outDir, "tex"));

        // Roads first: their middle is the map's origin
        (double x, double y, double z) ueToGame((double x, double y, double z) v) => (v.x / 100, v.z / 100, v.y / 100);
        Xodr.Graph roads = null;
        double ox = 0, oz = 0;
        if (xodr != null)
        {
            // OpenDRIVE (x, y, z) m → Unreal (x, −y, z) m → game (x, z, −y)
            roads = Xodr.Read(xodr, v => (v.x, v.z, -v.y));
            double minX = roads.Nodes.Min(n => n.x), maxX = roads.Nodes.Max(n => n.x), minZ = roads.Nodes.Min(n => n.z), maxZ = roads.Nodes.Max(n => n.z);
            ox = Math.Round((minX + maxX) / 2); oz = Math.Round((minZ + maxZ) / 2);
            Console.WriteLine($"roads: {roads.Nodes.Count} nodes, {roads.Links.Count} links, {roads.Km:F0} km");
        }

        // ---- Every level streamed in from the root ----
        var levels = new List<string>();
        var queue = new Queue<string>([rootLevel]);
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        while (queue.Count > 0)
        {
            var path = queue.Dequeue();
            if (!seen.Add(path)) continue;
            UWorld world;
            try { world = Program.LoadWorld(p, path); }
            catch (Exception e) { Console.WriteLine($"  ! {path}: {e.Message}"); continue; }
            levels.Add(path);
            foreach (var s in world.StreamingLevels ?? [])
            {
                var ls = s.Load();
                var asset = ls?.GetOrDefault<FSoftObjectPath>("WorldAsset").AssetPathName.Text;
                if (string.IsNullOrEmpty(asset)) continue;
                var pkg = asset.Contains('.') ? asset[..asset.LastIndexOf('.')] : asset;
                if (SkipLevels.Any(w => pkg.Contains(w, StringComparison.OrdinalIgnoreCase))) continue;
                queue.Enqueue(pkg);
            }
        }
        // A CARLA large map: its tiles aren't streamed by the level but by its LargeMapManager, each tile
        // level in its own frame, centred at Tile0Offset + (x, −y) × TileSide
        var levelOffset = new Dictionary<string, double[]>(StringComparer.OrdinalIgnoreCase);
        try
        {
            var root = Program.LoadWorld(p, rootLevel).PersistentLevel.Load<ULevel>();
            foreach (var a in root.Actors)
            {
                var actor = a?.Load();
                if (actor?.ExportType != "LargeMapManager") continue;
                var t0 = actor.GetOrDefault("Tile0Offset", new FVector(0, 0, 0));
                var side = actor.GetOrDefault("TileSide", 200000f);
                var dir = rootLevel[..rootLevel.LastIndexOf('/')];
                var name = rootLevel[(rootLevel.LastIndexOf('/') + 1)..];
                var re = new System.Text.RegularExpressions.Regex($"^{System.Text.RegularExpressions.Regex.Escape(dir)}/{name}_Tile_(\\d+)_(\\d+)\\.umap$", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
                foreach (var f in p.Files.Keys)
                {
                    var m = re.Match(f);
                    if (!m.Success) continue;
                    int tx = int.Parse(m.Groups[1].Value), ty = int.Parse(m.Groups[2].Value);
                    var lvl = f[..^5];
                    levels.Add(lvl);
                    levelOffset[lvl] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, tx * side + t0.X, -ty * side + t0.Y, t0.Z, 1];
                }
                Console.WriteLine($"large map: {levelOffset.Count} tiles of {side / 100} m from {t0}");
            }
        }
        catch (Exception e) { Console.WriteLine($"  ! large map: {e.Message}"); }
        Console.WriteLine($"levels: {levels.Count}");

        // ---- Meshes, materials, placements ----
        var meshes = new Dictionary<string, Mesh>();
        var mats = new Dictionary<string, Mat>();
        var textures = new Dictionary<string, UTexture2D>(StringComparer.OrdinalIgnoreCase);
        var texNames = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase); // texture path → name used
        string TexName(UTexture2D t)
        {
            if (t == null) return null;
            var path = t.GetPathName();
            if (texNames.TryGetValue(path, out var n)) return n;
            n = t.Name;
            for (int k = 2; textures.ContainsKey(n); k++) n = $"{t.Name}_{k}";
            textures[n] = t;
            texNames[path] = n;
            return n;
        }
        Mat MatFor(UMaterialInterface mi)
        {
            var key = mi?.GetPathName() ?? "none";
            if (mats.TryGetValue(key, out var m)) return m;
            m = new Mat { Index = mats.Count };
            mats[key] = m;
            if (mi == null) return m;
            try
            {
                var mp = new CMaterialParams2();
                mi.GetParams(mp, EMaterialDepth.AllLayers);
                if (mp.TryGetTexture2d(out var d, CMaterialParams2.Diffuse[0]) || mp.TryGetTexture2d(out d, CMaterialParams2.FallbackDiffuse)) m.Diffuse = TexName(d as UTexture2D);
                if (mp.TryGetTexture2d(out var nrm, CMaterialParams2.Normals[0]) || mp.TryGetTexture2d(out nrm, CMaterialParams2.FallbackNormals)) m.Normal = TexName(nrm as UTexture2D);
                m.Blend = mp.BlendMode is EBlendMode.BLEND_Translucent or EBlendMode.BLEND_Additive or EBlendMode.BLEND_Modulate;
                m.Mask = mp.BlendMode == EBlendMode.BLEND_Masked;
            }
            catch (Exception e) { Console.WriteLine($"  ! material {key}: {e.Message}"); }
            // The base material's name: what it is (glass, water, decal…)
            UObject cur = mi;
            for (int i = 0; i < 8 && cur is UMaterialInstance inst && inst.Parent != null; i++) cur = inst.Parent;
            m.Shader = (cur?.Name ?? mi.Name).ToLowerInvariant();
            if (m.Shader.Contains("glass") || mi.Name.Contains("glass", StringComparison.OrdinalIgnoreCase)) m.Shader += "_glass";
            m.Water = m.Shader.Contains("water") || mi.Name.Contains("water", StringComparison.OrdinalIgnoreCase) || (m.Normal ?? "").Contains("water", StringComparison.OrdinalIgnoreCase) || (m.Diffuse ?? "").Contains("water", StringComparison.OrdinalIgnoreCase);
            return m;
        }
        // The LOD: the most detailed within a budget for one copy (by size) and for all its copies in the
        // map together, so a tree planted 50 000 times comes at its lightest and a one-off tower keeps its detail
        Mesh MeshFor(UStaticMesh sm, long copies)
        {
            var key = sm.GetPathName();
            if (meshes.TryGetValue(key, out var mesh)) return mesh;
            meshes[key] = null;
            var lods = sm.RenderData?.LODs?.Where(l => !l.SkipLod).ToArray();
            if (lods == null || lods.Length == 0) return null;
            float radius = (sm.RenderData.Bounds?.SphereRadius ?? 100) / 100f;
            long budget = radius < 3 ? 1500 : radius < 10 ? 5000 : radius < 40 ? 30000 : 150000;
            long Tris(FStaticMeshLODResources l) => l.Sections.Sum(s => (long)s.NumTriangles);
            var lod = lods.FirstOrDefault(l => Tris(l) <= budget && Tris(l) * copies <= PerMesh) ?? lods[^1];
            var col = lods.LastOrDefault(l => Tris(l) >= 12) ?? lod;
            int n = lod.PositionVertexBuffer!.Verts.Length;
            mesh = new Mesh { Pos = new float[n * 3], Nrm = new float[n * 3], Uv = new float[n * 2], Idx = lod.IndexBuffer!.Buffer!, Radius = radius, Triangles = Tris(lod), Name = $"{sm.Name} (LOD {Array.IndexOf(lods, lod)}/{lods.Length}, r {radius:F1} m)" };
            for (int i = 0; i < n; i++)
            {
                var v = lod.PositionVertexBuffer.Verts[i];
                mesh.Pos[i * 3] = v.X; mesh.Pos[i * 3 + 1] = v.Y; mesh.Pos[i * 3 + 2] = v.Z;
                var item = lod.VertexBuffer!.UV[i];
                var nn = (FVector)item.Normal[2];
                mesh.Nrm[i * 3] = nn.X; mesh.Nrm[i * 3 + 1] = nn.Y; mesh.Nrm[i * 3 + 2] = nn.Z;
                if (item.UV.Length > 0) { mesh.Uv[i * 2] = item.UV[0].U; mesh.Uv[i * 2 + 1] = item.UV[0].V; }
            }
            mesh.Sections = lod.Sections.Select(s => (s.MaterialIndex, s.FirstIndex, s.NumTriangles)).ToArray();
            mesh.Mats = sm.StaticMaterials.Select(s => MatFor(s.MaterialInterface?.Load<UMaterialInterface>())).ToArray();
            if (mesh.Mats.Length == 0) mesh.Mats = sm.Materials.Select(mi => MatFor(mi?.Load<UMaterialInterface>())).ToArray();
            int cn = col.PositionVertexBuffer!.Verts.Length;
            mesh.ColPos = new float[cn * 3];
            for (int i = 0; i < cn; i++) { var v = col.PositionVertexBuffer.Verts[i]; mesh.ColPos[i * 3] = v.X; mesh.ColPos[i * 3 + 1] = v.Y; mesh.ColPos[i * 3 + 2] = v.Z; }
            mesh.ColIdx = col.IndexBuffer!.Buffer!;
            var lower = key.ToLowerInvariant();
            mesh.Foliage = FoliageWords.Any(lower.Contains);
            mesh.Drive = DriveWords.Any(lower.Contains) || radius > 60;
            mesh.NoCollide = NoCollideWords.Any(lower.Contains);
            mesh.Min = [float.MaxValue, float.MaxValue, float.MaxValue];
            mesh.Max = [float.MinValue, float.MinValue, float.MinValue];
            for (int i = 0; i < mesh.Pos.Length; i += 3)
                for (int k = 0; k < 3; k++) { mesh.Min[k] = Math.Min(mesh.Min[k], mesh.Pos[i + k]); mesh.Max[k] = Math.Max(mesh.Max[k], mesh.Pos[i + k]); }
            // Still over the budget at its lightest: keep an even share of its copies
            mesh.Keep = Math.Min(1, (double)PerMeshMax / Math.Max(1, mesh.Triangles * copies));
            meshes[key] = mesh;
            return mesh;
        }

        var cells = new Dictionary<(int, int), Dictionary<int, Batch>>();
        var colCells = new Dictionary<(int, int), (List<float> v, List<uint> i)>();
        long triangles = 0, colTris = 0;
        int placedCount = 0, skipped = 0;
        var bmin = (x: double.MaxValue, z: double.MaxValue); var bmax = (x: double.MinValue, z: double.MinValue);

        var cost = new Dictionary<Mesh, (string name, long count)>();
        void Place(Mesh mesh, double[] w, Mat[] overrides, bool foliage)
        {
            placedCount++;
            cost[mesh] = (cost.GetValueOrDefault(mesh).name ?? mesh.Name, cost.GetValueOrDefault(mesh).count + 1);
            // Normals: the inverse transpose of the 3×3 part (non-uniform scale); a mirrored placement flips winding
            double a = w[0], b = w[1], c = w[2], d = w[4], e = w[5], f = w[6], g = w[8], h = w[9], k = w[10];
            double det = a * (e * k - f * h) - b * (d * k - f * g) + c * (d * h - e * g);
            bool flip = det < 0;
            double[] it = [(e * k - f * h), -(d * k - f * g), (d * h - e * g), -(b * k - c * h), (a * k - c * g), -(a * h - b * g), (b * f - c * e), -(a * f - c * d), (a * e - b * d)];
            (float, float, float) P(float[] src, int v)
            {
                double x = src[v * 3], y = src[v * 3 + 1], z = src[v * 3 + 2];
                double wx = x * w[0] + y * w[4] + z * w[8] + w[12], wy = x * w[1] + y * w[5] + z * w[9] + w[13], wz = x * w[2] + y * w[6] + z * w[10] + w[14];
                return ((float)(wx / 100 - ox), (float)(wz / 100), (float)(wy / 100 - oz));
            }
            bool detail = mesh.Radius * Math.Cbrt(Math.Abs(det)) < DetailRadius;
            var remaps = new Dictionary<(int, int), Dictionary<uint, uint>>();
            foreach (var (mi, first, count) in mesh.Sections)
            {
                var mat = overrides != null && mi < overrides.Length && overrides[mi] != null ? overrides[mi] : mi < mesh.Mats.Length ? mesh.Mats[mi] : MatFor(null);
                if (mat.Water) continue; // the game's own ocean takes its place
                int bkey = mat.Index * 2 + (detail ? 1 : 0);
                for (int t = 0; t < count; t++)
                {
                    uint i0 = mesh.Idx[first + t * 3], i1 = mesh.Idx[first + t * 3 + 1], i2 = mesh.Idx[first + t * 3 + 2];
                    if (flip) (i1, i2) = (i2, i1);
                    var p0 = P(mesh.Pos, (int)i0); var p1 = P(mesh.Pos, (int)i1); var p2 = P(mesh.Pos, (int)i2);
                    float cx = (p0.Item1 + p1.Item1 + p2.Item1) / 3, cz = (p0.Item3 + p1.Item3 + p2.Item3) / 3;
                    var cellKey = ((int)MathF.Floor(cx / CellSize), (int)MathF.Floor(cz / CellSize));
                    if (!cells.TryGetValue(cellKey, out var batches)) cells[cellKey] = batches = [];
                    if (!batches.TryGetValue(bkey, out var batch)) batches[bkey] = batch = new Batch { Detail = detail };
                    if (!remaps.TryGetValue((cellKey.Item1 * 100000 + cellKey.Item2, bkey), out var remap)) remaps[(cellKey.Item1 * 100000 + cellKey.Item2, bkey)] = remap = [];
                    foreach (var (vi, pp) in new[] { (i0, p0), (i1, p1), (i2, p2) })
                    {
                        if (!remap.TryGetValue(vi, out var ni))
                        {
                            ni = (uint)(batch.Pos.Count / 3);
                            remap[vi] = ni;
                            batch.Pos.Add(pp.Item1); batch.Pos.Add(pp.Item2); batch.Pos.Add(pp.Item3);
                            double nx = mesh.Nrm[vi * 3], ny = mesh.Nrm[vi * 3 + 1], nz = mesh.Nrm[vi * 3 + 2];
                            double tx = nx * it[0] + ny * it[1] + nz * it[2], ty = nx * it[3] + ny * it[4] + nz * it[5], tz = nx * it[6] + ny * it[7] + nz * it[8];
                            double len = Math.Sqrt(tx * tx + ty * ty + tz * tz);
                            if (len < 1e-9 || double.IsNaN(len)) { tx = 0; ty = 0; tz = 1; len = 1; }
                            // Unreal (x, y, z) → game (x, z, y)
                            batch.Nrm.Add((float)(tx / len)); batch.Nrm.Add((float)(tz / len)); batch.Nrm.Add((float)(ty / len));
                            batch.Uv.Add(mesh.Uv[vi * 2]); batch.Uv.Add(mesh.Uv[vi * 2 + 1]);
                        }
                        batch.Idx.Add(ni);
                    }
                    triangles++;
                    bmin = (Math.Min(bmin.x, cx), Math.Min(bmin.z, cz)); bmax = (Math.Max(bmax.x, cx), Math.Max(bmax.z, cz));
                }
            }
            // Collision: the coarsest LOD, not for foliage, glass or cut-outs
            if (foliage || mesh.Foliage || mesh.NoCollide || mesh.Radius < 0.4f) return;
            float[] cpos = mesh.ColPos;
            uint[] cidx = mesh.ColIdx;
            if (!mesh.Drive)
            {
                // Its box: 8 corners, 12 triangles (outward faces)
                if (mesh.Max[2] - mesh.Min[2] < 40) return; // flat (under 40 cm tall): nothing to hit
                cpos = new float[24];
                for (int q = 0; q < 8; q++)
                {
                    cpos[q * 3] = (q & 1) == 0 ? mesh.Min[0] : mesh.Max[0];
                    cpos[q * 3 + 1] = (q & 2) == 0 ? mesh.Min[1] : mesh.Max[1];
                    cpos[q * 3 + 2] = (q & 4) == 0 ? mesh.Min[2] : mesh.Max[2];
                }
                cidx = BoxIndex;
            }
            for (int t = 0; t + 2 < cidx.Length; t += 3)
            {
                uint i0 = cidx[t], i1 = cidx[t + 1], i2 = cidx[t + 2];
                if (flip) (i1, i2) = (i2, i1);
                var p0 = P(cpos, (int)i0); var p1 = P(cpos, (int)i1); var p2 = P(cpos, (int)i2);
                var cellKey = ((int)MathF.Floor((p0.Item1 + p1.Item1 + p2.Item1) / 3 / CellSize), (int)MathF.Floor((p0.Item3 + p1.Item3 + p2.Item3) / 3 / CellSize));
                if (!colCells.TryGetValue(cellKey, out var cc)) colCells[cellKey] = cc = ([], []);
                uint baseI = (uint)(cc.v.Count / 3);
                foreach (var pp in new[] { p0, p1, p2 }) { cc.v.Add(pp.Item1); cc.v.Add(pp.Item2); cc.v.Add(pp.Item3); }
                cc.i.Add(baseI); cc.i.Add(baseI + 1); cc.i.Add(baseI + 2);
                colTris++;
            }
        }

        var worldOf = new Dictionary<USceneComponent, double[]>();
        double[] WorldOf(USceneComponent c, int depth = 0)
        {
            if (worldOf.TryGetValue(c, out var m)) return m;
            m = Mat4(c.GetRelativeTransform());
            if (depth < 32 && c.AttachParent != null && !c.AttachParent.IsNull && c.AttachParent.TryLoad(out USceneComponent parent))
                m = Mul(m, WorldOf(parent, depth + 1));
            return worldOf[c] = m;
        }

        // Pass 1: every placement, and how many copies of each mesh the map has
        int before = 0;
        // (a mesh by path only: loaded meshes keep every LOD in memory, so each is loaded once, in pass 2)
        var pending = new List<(string mesh, double[] world, Mat[] overrides, bool foliage)>();
        var copies = new Dictionary<string, long>();
        foreach (var level in levels)
        {
            IPackage pkg;
            try { pkg = p.LoadPackage(level.StartsWith('/') ? level : level + ".umap"); }
            catch (Exception e) { Console.WriteLine($"  ! {level}: {e.Message}"); continue; }
            var offset = levelOffset.GetValueOrDefault(level);
            worldOf.Clear();
            foreach (var obj in pkg.GetExports())
            {
                if (obj is not UStaticMeshComponent smc) continue;
                if (!smc.GetOrDefault("bVisible", true) || smc.GetOrDefault("bHiddenInGame", false)) { skipped++; continue; }
                string path;
                try { path = smc.GetStaticMesh().ResolvedObject?.GetPathName(); } catch { continue; }
                if (string.IsNullOrEmpty(path)) continue;
                var overrides = smc.GetOrDefault<FPackageIndex[]>("OverrideMaterials")?.Select(o => o == null || o.IsNull ? null : MatFor(o.Load<UMaterialInterface>())).ToArray();
                bool foliage = smc.ExportType.Contains("Foliage");
                var world = WorldOf(smc);
                if (offset != null) world = Mul(world, offset);
                if (smc is UInstancedStaticMeshComponent ism)
                    foreach (var inst in ism.GetInstances()) pending.Add((path, Mul(Mat4(inst.TransformData), world), overrides, foliage));
                else pending.Add((path, world, overrides, foliage));
                copies[path] = copies.GetValueOrDefault(path) + (smc is UInstancedStaticMeshComponent i2 ? i2.GetInstances().Length : 1);
            }
            Console.WriteLine($"  {level}: {pending.Count - before} placements");
            before = pending.Count;
        }
        // Pass 2: geometry, one mesh at a time (loaded, placed everywhere, let go)
        var kept = new Dictionary<Mesh, double>();
        foreach (var group in pending.GroupBy(q => q.mesh))
        {
            Mesh mesh;
            try
            {
                var sm = p.LoadPackageObject<UStaticMesh>(group.Key);
                if ((sm.RenderData?.Bounds?.SphereRadius ?? 0) > 2_000_000) continue; // sky domes and the like
                mesh = MeshFor(sm, copies[group.Key]);
            }
            catch (Exception e) { Console.WriteLine($"  ! mesh {group.Key}: {e.Message}"); continue; }
            if (mesh == null) continue;
            foreach (var (_, world, overrides, foliage) in group)
            {
                if (mesh.Keep < 1)
                {
                    // An even share: place this copy when the running share passes the next whole number
                    var acc = kept.GetValueOrDefault(mesh);
                    kept[mesh] = acc + mesh.Keep;
                    if (Math.Floor(acc + mesh.Keep) == Math.Floor(acc)) continue;
                }
                Place(mesh, world, overrides, foliage);
            }
            // Its geometry is in the cells now
            mesh.Pos = mesh.Nrm = mesh.Uv = mesh.ColPos = null;
            mesh.Idx = mesh.ColIdx = null;
        }
        foreach (var (m, (name, count)) in cost.OrderByDescending(kv => kv.Key.Triangles * kv.Value.count).Take(20))
            Console.WriteLine($"  {m.Triangles * count / 1e6,8:F2} M tris  {count,6} × {m.Triangles,7}  {name}{(m.Foliage ? " [foliage]" : "")}");
        Console.WriteLine($"placed {placedCount} ({skipped} hidden), {meshes.Count(m => m.Value != null)} meshes, {mats.Count} materials, {triangles} tris, {colTris} collision tris");

        // ---- Crop: cells far from every road are backdrop ----
        if (roads is { Nodes.Count: > 0 })
        {
            var near = new HashSet<(int, int)>();
            int reach = (int)Math.Ceiling(Crop / CellSize);
            foreach (var n in roads.Nodes)
            {
                double x = n.x - ox, z = n.z - oz;
                int cx = (int)Math.Floor(x / CellSize), cz = (int)Math.Floor(z / CellSize);
                for (int dx = -reach; dx <= reach; dx++)
                    for (int dz = -reach; dz <= reach; dz++)
                    {
                        double x0 = (cx + dx) * CellSize, z0 = (cz + dz) * CellSize;
                        double ddx = Math.Max(Math.Max(x0 - x, 0), x - (x0 + CellSize)), ddz = Math.Max(Math.Max(z0 - z, 0), z - (z0 + CellSize));
                        if (ddx * ddx + ddz * ddz <= Crop * Crop) near.Add((cx + dx, cz + dz));
                    }
            }
            var cropped = cells.Keys.Union(colCells.Keys).Where(k => !near.Contains(k)).ToList();
            foreach (var k in cropped)
            {
                if (cells.Remove(k, out var bs)) triangles -= bs.Values.Sum(b => b.Idx.Count / 3);
                if (colCells.Remove(k, out var cc)) colTris -= cc.i.Count / 3;
            }
            Console.WriteLine($"cropped {cropped.Count} cells farther than {Crop} m from the roads");
        }

        // ---- Write cells (the tools/gta5conv format) ----
        var matList = mats.Values.OrderBy(m => m.Index).ToList();
        var cellList = new JsonArray();
        var usedTex = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        int cellId = 0;
        foreach (var key in cells.Keys.Union(colCells.Keys).OrderBy(k => k.Item1).ThenBy(k => k.Item2))
        {
            var id = cellId++;
            var cellTex = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            long cellTris = 0;
            float[] mn = [float.MaxValue, float.MaxValue, float.MaxValue], mx = [float.MinValue, float.MinValue, float.MinValue];
            if (cells.TryGetValue(key, out var batches))
            {
                var header = new JsonArray();
                foreach (var (bk, b) in batches)
                {
                    var hdr = new JsonObject { ["material"] = bk / 2, ["vertices"] = b.Pos.Count / 3, ["indices"] = b.Idx.Count };
                    if (b.Detail) hdr["detail"] = true;
                    header.Add(hdr);
                    cellTris += b.Idx.Count / 3;
                    var m = matList[bk / 2];
                    if (m.Diffuse != null) cellTex.Add(m.Diffuse);
                    if (m.Normal != null) cellTex.Add(m.Normal);
                    for (int i = 0; i < b.Pos.Count; i += 3)
                        for (int k = 0; k < 3; k++) { mn[k] = Math.Min(mn[k], b.Pos[i + k]); mx[k] = Math.Max(mx[k], b.Pos[i + k]); }
                }
                var json = System.Text.Encoding.UTF8.GetBytes(new JsonObject { ["batches"] = header }.ToJsonString());
                using var fs = File.Create(Path.Combine(outDir, "cells", $"{id}.bin"));
                using var bw = new BinaryWriter(fs);
                bw.Write((uint)json.Length);
                bw.Write(json);
                while (fs.Position % 4 != 0) bw.Write((byte)0);
                foreach (var (_, b) in batches)
                {
                    for (int v = 0; v < b.Pos.Count / 3; v++)
                    {
                        bw.Write(b.Pos[v * 3]); bw.Write(b.Pos[v * 3 + 1]); bw.Write(b.Pos[v * 3 + 2]);
                        bw.Write(b.Nrm[v * 3]); bw.Write(b.Nrm[v * 3 + 1]); bw.Write(b.Nrm[v * 3 + 2]);
                        bw.Write(b.Uv[v * 2]); bw.Write(b.Uv[v * 2 + 1]);
                    }
                    foreach (var i in b.Idx) bw.Write(i);
                }
            }
            bool hasCol = colCells.TryGetValue(key, out var col);
            if (hasCol)
            {
                using var fs = File.Create(Path.Combine(outDir, "col", $"{id}.bin"));
                using var bw = new BinaryWriter(fs);
                bw.Write((uint)(col.v.Count / 3)); bw.Write((uint)col.i.Count);
                foreach (var f in col.v) bw.Write(f);
                foreach (var i in col.i) bw.Write(i);
            }
            usedTex.UnionWith(cellTex);
            cellList.Add(new JsonObject
            {
                ["id"] = id, ["x"] = key.Item1 * CellSize, ["z"] = key.Item2 * CellSize,
                ["render"] = batches != null, ["collision"] = hasCol, ["triangles"] = cellTris,
                ["textures"] = new JsonArray(cellTex.Order().Select(t => (JsonNode)t).ToArray()),
                ["min"] = batches != null ? new JsonArray(mn[0], mn[1], mn[2]) : null,
                ["max"] = batches != null ? new JsonArray(mx[0], mx[1], mx[2]) : null,
            });
        }

        // ---- Textures ----
        int written = 0;
        var missing = new List<string>();
        foreach (var name in usedTex)
        {
            try { if (WriteTexture(textures[name], Path.Combine(outDir, "tex", name + ".gtx"))) { written++; continue; } }
            catch (Exception e) { Console.WriteLine($"  ! texture {name}: {e.Message}"); }
            missing.Add(name);
        }
        Console.WriteLine($"textures: {written} written, {missing.Count} not ({string.Join(", ", missing.Take(8))})");

        var matJson = new JsonArray(matList.Select(m => (JsonNode)new JsonObject
        {
            ["shader"] = m.Shader,
            ["diffuse"] = m.Diffuse != null && !missing.Contains(m.Diffuse) ? m.Diffuse : null,
            ["normal"] = m.Normal != null && !missing.Contains(m.Normal) ? m.Normal : null,
            ["emissive"] = false, ["blend"] = m.Blend, ["mask"] = m.Mask,
        }).ToArray());

        // ---- Roads ----
        var nodes = new JsonArray();
        var links = new JsonArray();
        if (roads != null)
        {
            foreach (var n in roads.Nodes) nodes.Add(new JsonArray(Math.Round(n.x - ox, 2), Math.Round(n.y, 2), Math.Round(n.z - oz, 2)));
            foreach (var l in roads.Links) links.Add(new JsonArray(l.a, l.b, l.ab, l.ba));
        }
        File.WriteAllText(Path.Combine(outDir, "roads.json"), new JsonObject
        {
            ["nodes"] = nodes, ["flags"] = new JsonArray(Enumerable.Repeat(0, roads?.Nodes.Count ?? 0).Select(v => (JsonNode)v).ToArray()), ["links"] = links,
        }.ToJsonString());

        var spawn = new JsonArray(0.0, 2.0, 0.0);
        if (roads is { Nodes.Count: > 0 })
        {
            var best = roads.Nodes.OrderBy(n => (n.x - ox) * (n.x - ox) + (n.z - oz) * (n.z - oz)).First();
            spawn = new JsonArray(best.x - ox, best.y + 1, best.z - oz);
        }
        var manifest = new JsonObject
        {
            ["origin"] = new JsonArray(ox, 0, oz),
            ["cellSize"] = CellSize,
            ["spawn"] = spawn,
            ["cells"] = cellList,
            ["materials"] = matJson,
            ["stats"] = new JsonObject
            {
                ["entities"] = placedCount, ["missingEntities"] = 0, ["triangles"] = triangles, ["collisionTriangles"] = colTris,
                ["textures"] = written, ["roadNodes"] = roads?.Nodes.Count ?? 0, ["roadsDerived"] = false, ["croppedCells"] = 0, ["water"] = null,
                ["seaLevel"] = SeaLevel,
            },
        };
        File.WriteAllText(Path.Combine(outDir, "manifest.json"), manifest.ToJsonString(new System.Text.Json.JsonSerializerOptions { WriteIndented = true }));
        Console.WriteLine($"{outDir}: {placedCount} placed, {triangles} tris, {cellList.Count} cells, {colTris} collision tris, {written} textures, {roads?.Nodes.Count ?? 0} road nodes");
    }

    /** A texture as .gtx: DXT copied with its mips, anything else decoded and compressed. */
    static bool WriteTexture(UTexture2D t, string file)
    {
        var mips = t.PlatformData.Mips;
        int first = -1;
        for (int i = 0; i < mips.Length; i++)
            if (Math.Max(mips[i].SizeX, mips[i].SizeY) <= MaxTex && mips[i].EnsureValidBulkData(t.MipDataProvider, i)) { first = i; break; }
        if (first < 0) return false;
        if (t.Format is EPixelFormat.PF_DXT1 or EPixelFormat.PF_DXT5)
        {
            int block = t.Format == EPixelFormat.PF_DXT1 ? 8 : 16;
            var levels = new List<(int, int, byte[])>();
            for (int i = first; i < mips.Length; i++)
            {
                var m = mips[i];
                if (!m.EnsureValidBulkData(t.MipDataProvider, i)) break;
                int need = Math.Max(1, (m.SizeX + 3) / 4) * Math.Max(1, (m.SizeY + 3) / 4) * block;
                var data = m.BulkData!.Data!;
                if (data.Length < need) break;
                levels.Add((m.SizeX, m.SizeY, data.Length == need ? data : data[..need]));
            }
            if (levels.Count == 0) return false;
            Bc.WriteGtx(file, t.Format == EPixelFormat.PF_DXT1 ? 1 : 5, levels);
            return true;
        }
        var ct = t.Decode(mips[first]);
        if (ct == null) return false;
        int w = ct.Width, h = ct.Height;
        var src = ct.Data;
        var rgba = new byte[w * h * 4];
        switch (ct.PixelFormat)
        {
            case EPixelFormat.PF_B8G8R8A8:
                for (int i = 0; i < w * h; i++) { rgba[i * 4] = src[i * 4 + 2]; rgba[i * 4 + 1] = src[i * 4 + 1]; rgba[i * 4 + 2] = src[i * 4]; rgba[i * 4 + 3] = src[i * 4 + 3]; }
                break;
            case EPixelFormat.PF_R8G8B8A8:
                Array.Copy(src, rgba, Math.Min(src.Length, rgba.Length));
                break;
            case EPixelFormat.PF_G8:
                for (int i = 0; i < w * h; i++) { rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = src[i]; rgba[i * 4 + 3] = 255; }
                break;
            default:
                Console.WriteLine($"  ! texture {t.Name}: decoded as {ct.PixelFormat}");
                return false;
        }
        bool normal = t.IsNormalMap || t.Format == EPixelFormat.PF_BC5;
        bool alpha = false;
        for (int i = 0; i < w * h; i++)
        {
            if (normal)
            {
                // Two-channel normal maps: rebuild z
                double nx = rgba[i * 4] / 127.5 - 1, ny = rgba[i * 4 + 1] / 127.5 - 1;
                rgba[i * 4 + 2] = (byte)Math.Clamp((Math.Sqrt(Math.Max(0, 1 - nx * nx - ny * ny)) * 0.5 + 0.5) * 255, 0, 255);
                rgba[i * 4 + 3] = 255;
            }
            else if (rgba[i * 4 + 3] < 250) alpha = true;
        }
        Bc.WriteGtx(file, alpha ? 5 : 1, Bc.Chain(rgba, w, h, alpha));
        return true;
    }
}
