// Writes a GTA V map mod as streaming data for the game (public/mods/maps/<id>/):
//
//   manifest.json   origin, bounds, cell size, cells (with their textures), materials, spawn, stats
//   cells/<i>.bin   render geometry of one cell, merged per material (format below)
//   col/<i>.bin     collision triangles of one cell: u32 vertexCount, u32 indexCount, f32 xyz…, u32 idx…
//   tex/<name>.gtx  one texture: "GTX1", u32 format (1/3/5 = DXT1/3/5, 0 = RGBA8), u16 w, u16 h, u16 mips,
//                   u16 pad, then the mip chain (largest first)
//   roads.json      the path-node graph: nodes [[x,y,z]…] and links [[a, b, lanesAtoB, lanesBtoA]…]
//
// Options: --cell <m> cell size (200), --max-tex <px> (1024), --props <dir> (see MapExport.cs), and
//   --road-col <regex> / --road-mat <n,n…> / --road-tex <regex>   derive the road graph from the road surface
//       (collision files whose name matches, collision material types, render triangles whose diffuse
//       texture matches; see RoadDerive.cs) instead of the mod's path nodes, for mods that ship none
//   --skip-combined-col  skip a collision file that contains three or more others, taking it for a combined
//                     copy (the old default; it also drops big ground files). By default every collision file is
//                     kept and exact duplicate triangles are dropped. (--all-col is accepted and is the default.)
//   --crop <m>        leave out cells farther than this from every road node (distant scenery, sea planes)
//   --drop-water      leave out water surfaces (water shaders, textures named water/sea/ocean)
//   --render-col <regex>  also collide with the render meshes of entities whose archetype name matches
//                     (for mods whose buildings ship without collision)
//   --clip <file.json>  keep only what lies inside these loops ({"loops": [{"points": [[x, z], …]}, …]}, game
//                     frame, even-odd): a new coastline for a map whose land is a square block
//                     (scripts/shape-coast.mjs). Smaller entities are kept or left out whole by where they
//                     stand; bigger ones (ground, terrain) and the collision are trimmed triangle by triangle;
//                     road nodes outside are dropped
//
// Cell .bin: u32 json length, JSON { batches: [{ material, vertices, indices, colors?, detail? }] }, padding
// to 4 bytes, then per batch: f32 position×3, f32 normal×3, f32 uv×2 (+ u8 RGBA vertex colour when
// "colors": GTA's baked vertex shading, colour0) per vertex, then u32 indices. "detail" batches come from
// small entities (bounding radius under 8 m) and may be distance-culled; the rest is structure.
//
// Also written: hover.json, entities whose lowest point is more than 1.5 m above the collision surface
// below them (finding floating buildings), and render meshes of buildings without collision are added as
// collision (a building counts as covered when half its 8 m voxels hold collision triangles).
//
// Coordinates are converted to the game frame (+X forward/north, +Y up, +Z right/east) and recentred
// on the map's middle so float precision stays good.
using System.Text.Json;
using System.Text.Json.Nodes;
using CodeWalker.GameFiles;
using CodeWalker.Utils;
using SharpDX;

static class MapWriter
{
    class Batch
    {
        public readonly List<float> Pos = [], Nrm = [], Uv = [];
        public readonly List<uint> Idx = [], Col = [];
        public bool HasCol, Detail;
    }

    class MaterialInfo
    {
        public int Index;
        public string Shader = "", Diffuse, Normal;
        public bool Emissive, Blend, Mask;
    }

    public static void Write(ModFiles mod, string outDir, string[] args)
    {
        float cellSize = 200;
        int maxTex = 1024;
        bool allCol = true, dropWater = false;
        float crop = 0;
        System.Text.RegularExpressions.Regex roadCol = null, roadTex = null;
        HashSet<int> roadMat = null;
        System.Text.RegularExpressions.Regex renderColRe = null;
        var renderCol = new List<Vector3>(); // render triangles that also collide (--render-col)
        List<Vector2[]> clip = null;
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--cell") cellSize = float.Parse(args[++i]);
            if (args[i] == "--max-tex") maxTex = int.Parse(args[++i]);
            if (args[i] == "--all-col") allCol = true;
            if (args[i] == "--skip-combined-col") allCol = false;
            if (args[i] == "--drop-water") dropWater = true;
            if (args[i] == "--crop") crop = float.Parse(args[++i]);
            if (args[i] == "--road-col") roadCol = new(args[++i], System.Text.RegularExpressions.RegexOptions.IgnoreCase);
            if (args[i] == "--road-tex") roadTex = new(args[++i], System.Text.RegularExpressions.RegexOptions.IgnoreCase);
            if (args[i] == "--road-mat") roadMat = args[++i].Split(',').Select(int.Parse).ToHashSet();
            if (args[i] == "--render-col") renderColRe = new(args[++i], System.Text.RegularExpressions.RegexOptions.IgnoreCase);
            if (args[i] == "--clip")
                clip = JsonNode.Parse(File.ReadAllText(args[++i]))!["loops"]!.AsArray()
                    .Select(l => l!["points"]!.AsArray().Select(p => new Vector2((float)p![0]!, (float)p[1]!)).ToArray()).ToList();
        }
        // Inside the clip loops (even-odd over all of them), game frame
        var clipper = clip != null ? new Clipper(clip) : null;
        bool inside(float x, float z) => clipper == null || clipper.Inside(x, z);
        int clippedEntities = 0;
        bool deriveRoads = roadCol != null || roadTex != null || roadMat != null;
        var roadTris = new List<Vector3>(); // road surface triangles for RoadDerive, game frame
        var waterRe = new System.Text.RegularExpressions.Regex(@"(^|_)(water|sea|ocean)(_|\d|$)", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        long waterTris = 0; double waterArea = 0; float waterMinY = float.MaxValue, waterMaxY = float.MinValue;
        var waterTex = new HashSet<string>();
        Directory.CreateDirectory(Path.Combine(outDir, "cells"));
        Directory.CreateDirectory(Path.Combine(outDir, "col"));
        Directory.CreateDirectory(Path.Combine(outDir, "tex"));

        // Textures by name from every dictionary in the mod (and drawables' embedded ones, below)
        var textures = new Dictionary<string, Texture>(StringComparer.OrdinalIgnoreCase);
        foreach (var (_, path) in mod.Ytds)
        {
            var ytd = new YtdFile();
            ytd.Load(File.ReadAllBytes(path));
            foreach (var t in ytd.TextureDict?.Textures?.data_items ?? []) if (t?.Name != null) { textures.TryAdd(t.Name, t); textures.TryAdd(TexKey(t.Name), t); }
        }

        // Drawables by name hash: loose .ydr files, fragments (.yft), and every entry of .ydd dictionaries
        var drawablePaths = mod.Ydrs.ToDictionary(kv => JenkHash.GenHash(kv.Key), kv => kv.Value);
        var props = mod.PropNames.Select(n => JenkHash.GenHash(n)).ToHashSet();
        var fragPaths = mod.Yfts.ToDictionary(kv => JenkHash.GenHash(kv.Key), kv => kv.Value);
        var drawables = new Dictionary<uint, DrawableBase>();
        var propBounds = new Dictionary<uint, Bounds>();
        foreach (var (_, path) in mod.Ydds)
        {
            var ydd = new YddFile();
            ydd.Load(File.ReadAllBytes(path));
            foreach (var (hash, d) in ydd.Dict ?? []) drawables.TryAdd(hash, d);
        }
        DrawableBase drawableFor(uint hash)
        {
            if (drawables.TryGetValue(hash, out var d)) return d;
            DrawableBase found = null;
            string path = null;
            try
            {
                if (drawablePaths.TryGetValue(hash, out path))
                {
                    var ydr = new YdrFile();
                    ydr.Load(File.ReadAllBytes(path));
                    found = ydr.Drawable;
                    propBounds[hash] = ydr.Drawable?.Bound;
                }
                else if (fragPaths.TryGetValue(hash, out path))
                {
                    var yft = new YftFile();
                    yft.Load(File.ReadAllBytes(path));
                    found = yft.Fragment?.Drawable;
                    propBounds[hash] = yft.Fragment?.PhysicsLODGroup?.PhysicsLOD1?.Bound ?? yft.Fragment?.Drawable?.Bound;
                }
            }
            catch (Exception ex) { Console.WriteLine($"skipping unreadable {path}: {ex.GetType().Name}"); }
            foreach (var t in found?.ShaderGroup?.TextureDictionary?.Textures?.data_items ?? [])
                if (t?.Name != null) { textures.TryAdd(t.Name, t); textures.TryAdd(TexKey(t.Name), t); }
            return drawables[hash] = found;
        }

        // Entities. Skip SLODs and any LOD whose detailed children exist (they'd overlap them).
        var ymaps = mod.Ymaps.ToDictionary(kv => kv.Key, kv => { var y = new YmapFile(); y.Load(File.ReadAllBytes(kv.Value)); return y; });
        var byHash = ymaps.ToDictionary(kv => JenkHash.GenHash(kv.Key), kv => kv.Value);
        var hasChildren = new HashSet<YmapEntityDef>();
        foreach (var y in ymaps.Values)
        {
            if (!byHash.TryGetValue(y.CMapData.parent, out var parent) || parent.AllEntities == null) continue;
            foreach (var e in y.AllEntities ?? [])
            {
                var pi = e.CEntityDef.parentIndex;
                if (pi >= 0 && pi < parent.AllEntities.Length) hasChildren.Add(parent.AllEntities[pi]);
            }
        }
        // Interiors (MLOs): the instance entity places an archetype from a .ytyp whose room entities are
        // the actual buildings; CodeWalker turns them into world-space entities
        var mloArchetypes = new Dictionary<uint, MloArchetype>();
        foreach (var (_, path) in mod.Ytyps)
        {
            try
            {
                var yt = new YtypFile();
                yt.Load(File.ReadAllBytes(path));
                foreach (var a in yt.AllArchetypes ?? []) if (a is MloArchetype m) mloArchetypes.TryAdd(a.Hash, m);
            }
            catch (Exception ex) { Console.WriteLine($"skipping unreadable {path}: {ex.GetType().Name}"); }
        }
        IEnumerable<YmapEntityDef> expand(YmapFile y)
        {
            foreach (var e in y.AllEntities ?? [])
            {
                yield return e;
                if (!mloArchetypes.TryGetValue(e.CEntityDef.archetypeName, out var mlo)) continue;
                e.SetArchetype(mlo);
                foreach (var child in e.MloInstance?.Entities ?? []) yield return child;
            }
        }
        var placed = new List<(YmapEntityDef e, DrawableBase d)>();
        int missing = 0, mloEntities = 0;
        var missingNames = new Dictionary<string, int>();
        foreach (var y in ymaps.Values)
            foreach (var e in expand(y).ToList())
            {
                if (mloArchetypes.ContainsKey(e.CEntityDef.archetypeName)) continue; // the interior itself has no mesh
                if (e.MloParent != null) mloEntities++;
                var lod = e.CEntityDef.lodLevel;
                if (lod is rage__eLodType.LODTYPES_DEPTH_SLOD1 or rage__eLodType.LODTYPES_DEPTH_SLOD2 or rage__eLodType.LODTYPES_DEPTH_SLOD3 or rage__eLodType.LODTYPES_DEPTH_SLOD4) continue;
                if (hasChildren.Contains(e)) continue;
                var name = JenkIndex.GetString(e.CEntityDef.archetypeName);
                if (name.Contains("slod") || name.EndsWith("_lod")) continue;
                var d = drawableFor(e.CEntityDef.archetypeName);
                if (d == null) { missing++; missingNames[name] = missingNames.GetValueOrDefault(name) + 1; continue; }
                placed.Add((e, d));
            }

        // World positions → game frame; recentre on the middle of everything placed
        var min = new Vector3(float.MaxValue); var max = new Vector3(float.MinValue);
        foreach (var (e, _) in placed) { min = Vector3.Min(min, e.Position); max = Vector3.Max(max, e.Position); }
        var origin = (min + max) / 2;
        origin.Z = 0;
        Vector3 toGame(Vector3 world) => Axis.ToGame(world - origin);

        // Geometry into cells, merged per material
        var materials = new Dictionary<string, MaterialInfo>();
        var cells = new Dictionary<(int, int), Dictionary<int, Batch>>();
        long triangles = 0;
        var entMin = new Vector3[placed.Count];
        var entMax = new Vector3[placed.Count];
        var entVox = new HashSet<long>[placed.Count]; // 8 m voxels of each building's solid surfaces
        var clipped = new bool[placed.Count];
        for (int ei = 0; ei < placed.Count; ei++)
        {
            var (e, d) = placed[ei];
            var world = Matrix.Scaling(e.Scale) * Matrix.RotationQuaternion(e.Orientation) * Matrix.Translation(e.Position);
            bool isProp = props.Contains(e.CEntityDef.archetypeName);
            bool solid = renderColRe != null && renderColRe.IsMatch(JenkIndex.GetString(e.CEntityDef.archetypeName));
            float radius = d.BoundingSphereRadius * Math.Max(e.Scale.X, e.Scale.Z);
            // A new coastline: buildings and props stay or go whole; ground and terrain are trimmed below
            bool trim = clip != null && radius >= ClipWhole;
            if (clip != null && !trim)
            {
                var at = toGame(e.Position);
                if (!inside(at.X, at.Z)) { clipped[ei] = true; clippedEntities++; continue; }
            }
            bool detail = isProp || radius < DetailRadius;
            entMin[ei] = new Vector3(float.MaxValue); entMax[ei] = new Vector3(float.MinValue);
            if (!isProp && radius >= 1.5f) entVox[ei] = [];
            var boneM = BoneMatrices(d);
            foreach (var model in ModelsFor(d, isProp))
                foreach (var g in model.Geometries ?? [])
                {
                    // Parts of a fragment (and multi-part drawables) are modelled around their own bone
                    var modelWorld = model.HasSkin == 0 && model.BoneIndex < boneM.Length ? boneM[model.BoneIndex] * world : world;
                    var vd = g.VertexData;
                    var idx = g.IndexBuffer?.Indices;
                    if (vd?.Info == null || idx == null) continue;
                    var mat = MaterialFor(g.Shader, materials);
                    bool water = mat.Shader.StartsWith("water") || (mat.Diffuse != null && waterRe.IsMatch(mat.Diffuse));
                    if (water && dropWater) continue;
                    bool roadSurface = roadTex != null && mat.Diffuse != null && roadTex.IsMatch(mat.Diffuse);
                    var info = vd.Info;
                    bool has(int c) => ((info.Flags >> c) & 1) != 0;
                    var pos = new Vector3[vd.VertexCount];
                    var nrm = new Vector3[vd.VertexCount];
                    var uv = new Vector2[vd.VertexCount];
                    var col = new uint[vd.VertexCount];
                    bool hasColour = has(4) && info.GetComponentType(4) is VertexComponentType.Colour or VertexComponentType.UByte4;
                    for (int v = 0; v < vd.VertexCount; v++)
                    {
                        pos[v] = toGame(Vector3.TransformCoordinate(vd.GetVector3(v, 0), modelWorld));
                        if (hasColour) { var cc = vd.GetColour(v, 4); col[v] = (uint)(cc.R | cc.G << 8 | cc.B << 16 | cc.A << 24); }
                        else col[v] = 0xffffffff;
                        var n = has(3) ? info.GetComponentType(3) switch
                        {
                            VertexComponentType.Float3 => vd.GetVector3(v, 3),
                            VertexComponentType.RGBA8SNorm => (Vector3)vd.GetRGBA8SNorm(v, 3),
                            _ => Vector3.UnitZ,
                        } : Vector3.UnitZ;
                        // Some meshes carry zero-length normals; normalizing those gives NaN, which the
                        // renderer's bloom spreads over the whole screen
                        var tn = Vector3.TransformNormal(n, modelWorld);
                        nrm[v] = tn.LengthSquared() > 1e-12 && !float.IsNaN(tn.X) ? Axis.ToGame(Vector3.Normalize(tn)) : new Vector3(0, 1, 0);
                        if (has(6))
                            uv[v] = info.GetComponentType(6) switch
                            {
                                VertexComponentType.Float2 => vd.GetVector2(v, 6),
                                VertexComponentType.Half2 => new Vector2(vd.GetHalf2(v, 6).X, vd.GetHalf2(v, 6).Y),
                                _ => Vector2.Zero,
                            };
                    }
                    // The triangles, less what a new coastline (--clip) leaves out
                    IReadOnlyList<int> tri = idx.Take(Math.Min(idx.Length, (int)g.IndicesCount) / 3 * 3).Select(v => (int)v).ToArray();
                    if (trim)
                    {
                        var (lp, ln, lu, lc) = (pos.ToList(), nrm.ToList(), uv.ToList(), col.ToList());
                        tri = clipper!.Trim(lp, ln, lu, lc, tri).tri;
                        (pos, nrm, uv, col) = (lp.ToArray(), ln.ToArray(), lu.ToArray(), lc.ToArray());
                    }
                    // Each triangle goes to the cell holding its centroid; vertices are copied per cell as needed
                    var remap = new Dictionary<(int, int), Dictionary<int, uint>>();
                    bool solidSurface = !mat.Blend && !mat.Mask && !mat.Emissive && !water && !mat.Shader.Contains("decal") && !mat.Shader.Contains("glass");
                    for (int i = 0; i + 2 < tri.Count; i += 3)
                    {
                        var c = (pos[tri[i]] + pos[tri[i + 1]] + pos[tri[i + 2]]) / 3;
                        for (int k = 0; k < 3; k++) { entMin[ei] = Vector3.Min(entMin[ei], pos[tri[i + k]]); entMax[ei] = Vector3.Max(entMax[ei], pos[tri[i + k]]); }
                        if (solidSurface) entVox[ei]?.Add(Voxel(c));
                        var key = ((int)MathF.Floor(c.X / cellSize), (int)MathF.Floor(c.Z / cellSize));
                        if (roadSurface) roadTris.AddRange([pos[tri[i]], pos[tri[i + 1]], pos[tri[i + 2]]]);
                        if (solid && !mat.Blend) renderCol.AddRange([pos[tri[i]], pos[tri[i + 1]], pos[tri[i + 2]]]);
                        if (water)
                        {
                            waterTris++;
                            waterArea += Vector3.Cross(pos[tri[i + 1]] - pos[tri[i]], pos[tri[i + 2]] - pos[tri[i]]).Length() / 2;
                            waterMinY = Math.Min(waterMinY, c.Y); waterMaxY = Math.Max(waterMaxY, c.Y);
                            waterTex.Add(mat.Diffuse ?? mat.Shader);
                        }
                        if (!cells.TryGetValue(key, out var cell)) cells[key] = cell = [];
                        int bk = mat.Index * 2 + (detail ? 1 : 0);
                        if (!cell.TryGetValue(bk, out var b)) cell[bk] = b = new Batch { Detail = detail };
                        b.HasCol |= hasColour;
                        if (!remap.TryGetValue(key, out var map)) remap[key] = map = [];
                        for (int k = 0; k < 3; k++)
                        {
                            int vi = tri[i + k];
                            if (!map.TryGetValue(vi, out var ni))
                            {
                                ni = (uint)(b.Pos.Count / 3);
                                b.Pos.AddRange([pos[vi].X, pos[vi].Y, pos[vi].Z]);
                                b.Nrm.AddRange([nrm[vi].X, nrm[vi].Y, nrm[vi].Z]);
                                b.Uv.AddRange([uv[vi].X, uv[vi].Y]);
                                b.Col.Add(col[vi]);
                                map[vi] = ni;
                            }
                            b.Idx.Add(ni);
                        }
                        triangles++;
                    }
                }
        }

        // Collision from the mod's static bounds (already in world space)
        var colCells = new Dictionary<(int, int), (List<float> v, List<uint> i)>();
        long colTris = 0, colDuplicates = 0;
        var colVox = new HashSet<long>();
        var colTriList = new List<(Vector3 a, Vector3 b, Vector3 c)>();
        var colSeen = allCol ? new HashSet<(long, long, long)>() : null;
        long quant(Vector3 v) => ((long)MathF.Round(v.X * 50) * 73856093) ^ ((long)MathF.Round(v.Y * 50) * 19349663) ^ ((long)MathF.Round(v.Z * 50) * 83492791);
        // `trimmed`: already cut to the clip loops (whole pieces and split ground), so no centroid test
        void addTri(Vector3 a, Vector3 bb, Vector3 c, bool trimmed = false)
        {
            if (colSeen != null)
            {
                // Same triangle from two files (a combined copy of split ones): add it once
                long qa = quant(a), qb = quant(bb), qc = quant(c);
                var k = qa < qb ? (qb < qc ? (qa, qb, qc) : qa < qc ? (qa, qc, qb) : (qc, qa, qb)) : (qa < qc ? (qb, qa, qc) : qb < qc ? (qb, qc, qa) : (qc, qb, qa));
                if (!colSeen.Add(k)) { colDuplicates++; return; }
            }
            var m = (a + bb + c) / 3;
            if (clipper != null && !trimmed && !clipper.InsideFast(m.X, m.Z)) return;
            MarkVoxels(colVox, a, bb, c);
            colTriList.Add((a, bb, c));
            var key = ((int)MathF.Floor(m.X / cellSize), (int)MathF.Floor(m.Z / cellSize));
            if (!colCells.TryGetValue(key, out var cc)) colCells[key] = cc = ([], []);
            var baseIndex = (uint)(cc.v.Count / 3);
            cc.v.AddRange([a.X, a.Y, a.Z, bb.X, bb.Y, bb.Z, c.X, c.Y, c.Z]);
            cc.i.AddRange([baseIndex, baseIndex + 1, baseIndex + 2]);
            colTris++;
        }
        // `world` places the bound: identity for the map's own (world-space) bounds, the entity's matrix for props
        // `file` is the collision file's name, for picking road surfaces (--road-col); null for props
        void addBounds(Bounds b, Matrix world, string file = null)
        {
            Vector3 at(Vector3 local) => toGame(Vector3.TransformCoordinate(local, world));
            if (b is BoundComposite comp)
            {
                foreach (var ch in comp.Children?.data_items ?? []) if (ch != null) addBounds(ch, ch.Transform * world, file);
                return;
            }
            if (b is BoundBox or BoundCapsule or BoundCylinder)
            {
                // Primitives (lamp posts, tree trunks) as their bounding box: 12 triangles
                var lo = b.BoxMin; var hi = b.BoxMax;
                var c = new Vector3[8];
                for (int k = 0; k < 8; k++) c[k] = at(new Vector3((k & 1) != 0 ? hi.X : lo.X, (k & 2) != 0 ? hi.Y : lo.Y, (k & 4) != 0 ? hi.Z : lo.Z));
                int[] faces = [0, 1, 3, 2, 4, 6, 7, 5, 0, 4, 5, 1, 2, 3, 7, 6, 0, 2, 6, 4, 1, 5, 7, 3];
                for (int f = 0; f < 24; f += 4)
                {
                    addTri(c[faces[f]], c[faces[f + 1]], c[faces[f + 2]]);
                    addTri(c[faces[f]], c[faces[f + 2]], c[faces[f + 3]]);
                }
                return;
            }
            if (b is not BoundGeometry bg || bg.Polygons == null) return;
            bool roadFile = file != null && (roadCol != null || roadMat != null) && (roadCol == null || roadCol.IsMatch(file));
            // Triangles over shared vertices (so the clipper can find the pieces), and which are road
            var vp = new List<Vector3>();
            var vmap = new Dictionary<int, int>();
            var tris = new List<int>();
            var road = new List<bool>();
            int V(int i) { if (!vmap.TryGetValue(i, out var k)) { vmap[i] = k = vp.Count; vp.Add(at(bg.GetVertexPos(i))); } return k; }
            for (int pi = 0; pi < bg.Polygons.Length; pi++)
                if (bg.Polygons[pi] is BoundPolygonTriangle t)
                {
                    tris.AddRange([V(t.vertIndex1), V(t.vertIndex2), V(t.vertIndex3)]);
                    road.Add(roadFile && (roadMat == null || roadMat.Contains((int)bg.GetMaterial(pi).Type)));
                }
            var (keep, src) = clipper != null ? clipper.Trim(vp, null, null, null, tris) : (tris, Enumerable.Range(0, tris.Count / 3).ToList());
            for (int k = 0; k + 2 < keep.Count; k += 3)
            {
                Vector3 a = vp[keep[k]], b2 = vp[keep[k + 1]], c = vp[keep[k + 2]];
                addTri(a, b2, c, true);
                if (road[src[k / 3]]) roadTris.AddRange([a, b2, c]);
            }
        }
        // Some mods ship one combined collision file as well as split ones; skip any bound that
        // contains several others, so the same surfaces aren't added twice
        var ybns = mod.Ybns.Select(kv => { var y = new YbnFile(); y.Load(File.ReadAllBytes(kv.Value)); return (name: kv.Key, y); })
            .Where(x => x.y.Bounds != null).ToList();
        bool contains(Bounds a, Bounds b) => a != b
            && a.BoxMin.X <= b.BoxMin.X + 1 && a.BoxMin.Y <= b.BoxMin.Y + 1 && a.BoxMin.Z <= b.BoxMin.Z + 1
            && a.BoxMax.X >= b.BoxMax.X - 1 && a.BoxMax.Y >= b.BoxMax.Y - 1 && a.BoxMax.Z >= b.BoxMax.Z - 1;
        var skippedCol = new List<string>();
        foreach (var (name, y) in ybns)
            if (allCol || ybns.Count(o => contains(y.Bounds, o.y.Bounds)) < 3) addBounds(y.Bounds, Matrix.Identity, name);
            else skippedCol.Add(name);
        if (skippedCol.Count > 0) Console.WriteLine($"collision files taken for combined copies and skipped (--all-col keeps them): {string.Join(", ", skippedCol)}");
        if (colDuplicates > 0) Console.WriteLine($"{colDuplicates} duplicate collision triangles dropped");
        for (int i = 0; i + 2 < renderCol.Count; i += 3) addTri(renderCol[i], renderCol[i + 1], renderCol[i + 2]);
        if (renderCol.Count > 0) Console.WriteLine($"{renderCol.Count / 3} render triangles added as collision");
        // Bounds: add world-space bounds from .ybn files, plus embedded bounds from all placed drawables/props
        foreach (var (e, _) in placed.Where((_, i) => !clipped[i]))
            if (propBounds.TryGetValue(e.CEntityDef.archetypeName, out var pb) && pb != null)
                addBounds(pb, Matrix.Scaling(e.Scale) * Matrix.RotationQuaternion(e.Orientation) * Matrix.Translation(e.Position),
                    JenkIndex.GetString(e.CEntityDef.archetypeName));

        // Buildings without collision: their render mesh collides instead
        int fallback = 0;
        for (int ei = 0; ei < placed.Count; ei++)
        {
            var vox = entVox[ei];
            if (vox == null || vox.Count == 0) continue;
            int covered = vox.Count(v => colVox.Contains(v) || colVox.Contains(v + VoxelStepY) || colVox.Contains(v - VoxelStepY));
            if (covered * 2 >= vox.Count) continue;
            var (e, d) = placed[ei];
            var world = Matrix.Scaling(e.Scale) * Matrix.RotationQuaternion(e.Orientation) * Matrix.Translation(e.Position);
            var boneM = BoneMatrices(d);
            foreach (var model in ModelsFor(d, true))
                foreach (var g in model.Geometries ?? [])
                {
                    var mat = MaterialFor(g.Shader, materials);
                    if (mat.Blend || mat.Mask || mat.Emissive || mat.Shader.Contains("decal") || mat.Shader.Contains("glass") || mat.Shader.StartsWith("water")) continue;
                    var vd = g.VertexData;
                    var idx = g.IndexBuffer?.Indices;
                    if (vd == null || idx == null) continue;
                    var modelWorld = model.HasSkin == 0 && model.BoneIndex < boneM.Length ? boneM[model.BoneIndex] * world : world;
                    Vector3 P(int i) => toGame(Vector3.TransformCoordinate(vd.GetVector3(idx[i], 0), modelWorld));
                    for (int i = 0; i + 2 < idx.Length && i + 2 < g.IndicesCount; i += 3) addTri(P(i), P(i + 1), P(i + 2));
                }
            fallback++;
        }
        if (fallback > 0) Console.WriteLine($"{fallback} buildings without collision: render meshes added as collision");

        // Floating buildings: the lowest point well above whatever collision is below it
        var colIndex = new Dictionary<(int, int), List<int>>();
        for (int t = 0; t < colTriList.Count; t++)
        {
            var (a, b3, c) = colTriList[t];
            int x0 = (int)MathF.Floor(Math.Min(a.X, Math.Min(b3.X, c.X)) / 8), x1 = (int)MathF.Floor(Math.Max(a.X, Math.Max(b3.X, c.X)) / 8);
            int z0 = (int)MathF.Floor(Math.Min(a.Z, Math.Min(b3.Z, c.Z)) / 8), z1 = (int)MathF.Floor(Math.Max(a.Z, Math.Max(b3.Z, c.Z)) / 8);
            if ((x1 - x0 + 1) * (z1 - z0 + 1) > 4096) continue;
            for (int x = x0; x <= x1; x++) for (int z = z0; z <= z1; z++)
                { if (!colIndex.TryGetValue((x, z), out var l)) colIndex[(x, z)] = l = []; l.Add(t); }
        }
        float surfaceBelow(float x, float z, float top)
        {
            float best = float.NegativeInfinity;
            if (!colIndex.TryGetValue(((int)MathF.Floor(x / 8), (int)MathF.Floor(z / 8)), out var l)) return best;
            foreach (var t in l)
            {
                var (a, b3, c) = colTriList[t];
                float d = (b3.Z - c.Z) * (a.X - c.X) + (c.X - b3.X) * (a.Z - c.Z);
                if (MathF.Abs(d) < 1e-6f) continue;
                float w1 = ((b3.Z - c.Z) * (x - c.X) + (c.X - b3.X) * (z - c.Z)) / d;
                float w2 = ((c.Z - a.Z) * (x - c.X) + (a.X - c.X) * (z - c.Z)) / d;
                float w3 = 1 - w1 - w2;
                if (w1 < 0 || w2 < 0 || w3 < 0) continue;
                float y = w1 * a.Y + w2 * b3.Y + w3 * c.Y;
                if (y <= top && y > best) best = y;
            }
            return best;
        }
        var hover = new JsonArray();
        for (int ei = 0; ei < placed.Count; ei++)
        {
            if (entVox[ei] == null || entMin[ei].X > entMax[ei].X) continue;
            var lo = entMin[ei]; var hi = entMax[ei];
            float gap = float.PositiveInfinity;
            foreach (var (fx, fz) in new[] { (0.5f, 0.5f), (0.25f, 0.25f), (0.75f, 0.25f), (0.25f, 0.75f), (0.75f, 0.75f) })
            {
                float x = lo.X + (hi.X - lo.X) * fx, z = lo.Z + (hi.Z - lo.Z) * fz;
                gap = Math.Min(gap, lo.Y - surfaceBelow(x, z, lo.Y + 0.5f));
            }
            if (gap <= 1.5f) continue;
            var (e, _) = placed[ei];
            hover.Add(new JsonObject
            {
                ["name"] = JenkIndex.GetString(e.CEntityDef.archetypeName),
                ["at"] = new JsonArray(MathF.Round((lo.X + hi.X) / 2, 1), MathF.Round(lo.Y, 1), MathF.Round((lo.Z + hi.Z) / 2, 1)),
                ["size"] = new JsonArray(MathF.Round(hi.X - lo.X, 1), MathF.Round(hi.Y - lo.Y, 1), MathF.Round(hi.Z - lo.Z, 1)),
                ["gap"] = float.IsPositiveInfinity(gap) ? null : MathF.Round(gap, 1),
            });
        }
        File.WriteAllText(Path.Combine(outDir, "hover.json"), hover.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        Console.WriteLine($"{hover.Count} entities float more than 1.5 m above the collision below them (hover.json); {mloEntities} interior entities placed");

        // Roads: the mod's path nodes, or derived from the road surface
        var roads = deriveRoads ? DerivedRoads(roadTris) : Roads(mod, toGame);
        if (clip != null)
        {
            roads = ClipRoads(roads, inside);
            Console.WriteLine($"clip: {clippedEntities} entities left out, {roads.nodes.Count} road nodes kept");
        }
        File.WriteAllText(Path.Combine(outDir, "roads.json"), roads.json.ToJsonString());

        // Crop: cells too far from any road are scenery the player can't reach
        var cropped = new HashSet<(int, int)>();
        if (crop > 0 && roads.nodes.Count > 0)
        {
            var near = new HashSet<(int, int)>();
            int reach = (int)MathF.Ceiling(crop / cellSize);
            foreach (var n in roads.nodes)
            {
                int cx = (int)MathF.Floor(n.X / cellSize), cz = (int)MathF.Floor(n.Z / cellSize);
                for (int dx = -reach; dx <= reach; dx++)
                    for (int dz = -reach; dz <= reach; dz++)
                    {
                        // Distance from the node to that cell's rectangle
                        float x0 = (cx + dx) * cellSize, z0 = (cz + dz) * cellSize;
                        float ddx = Math.Max(Math.Max(x0 - n.X, 0), n.X - (x0 + cellSize)), ddz = Math.Max(Math.Max(z0 - n.Z, 0), n.Z - (z0 + cellSize));
                        if (ddx * ddx + ddz * ddz <= crop * crop) near.Add((cx + dx, cz + dz));
                    }
            }
            foreach (var k in cells.Keys.Union(colCells.Keys)) if (!near.Contains(k)) cropped.Add(k);
            foreach (var k in cropped)
            {
                if (cells.Remove(k, out var bs)) triangles -= bs.Values.Sum(b => b.Idx.Count / 3);
                if (colCells.Remove(k, out var cc)) colTris -= cc.i.Count / 3;
            }
            Console.WriteLine($"cropped {cropped.Count} cells farther than {crop} m from the roads");
        }

        // Write cells
        var cellList = new JsonArray();
        var usedTextures = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var matList = materials.Values.OrderBy(m => m.Index).ToList();
        int cellId = 0;
        foreach (var key in cells.Keys.Union(colCells.Keys).OrderBy(k => k.Item1).ThenBy(k => k.Item2))
        {
            var id = cellId++;
            var cellTex = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            long cellTris = 0;
            var bmin = new Vector3(float.MaxValue); var bmax = new Vector3(float.MinValue);
            if (cells.TryGetValue(key, out var batches))
            {
                var header = new JsonArray();
                foreach (var (mi, b) in batches)
                {
                    var h = new JsonObject { ["material"] = mi / 2, ["vertices"] = b.Pos.Count / 3, ["indices"] = b.Idx.Count };
                    if (b.HasCol) h["colors"] = true;
                    if (b.Detail) h["detail"] = true;
                    header.Add(h);
                    cellTris += b.Idx.Count / 3;
                    var m = matList[mi / 2];
                    if (m.Diffuse != null) cellTex.Add(m.Diffuse);
                    if (m.Normal != null) cellTex.Add(m.Normal);
                    for (int i = 0; i < b.Pos.Count; i += 3)
                    {
                        var p = new Vector3(b.Pos[i], b.Pos[i + 1], b.Pos[i + 2]);
                        bmin = Vector3.Min(bmin, p); bmax = Vector3.Max(bmax, p);
                    }
                }
                var json = System.Text.Encoding.UTF8.GetBytes(new JsonObject { ["batches"] = header }.ToJsonString());
                using var fs = File.Create(Path.Combine(outDir, "cells", $"{id}.bin"));
                using var w = new BinaryWriter(fs);
                w.Write((uint)json.Length);
                w.Write(json);
                while (fs.Position % 4 != 0) w.Write((byte)0);
                foreach (var (_, b) in batches)
                {
                    for (int v = 0; v < b.Pos.Count / 3; v++)
                    {
                        w.Write(b.Pos[v * 3]); w.Write(b.Pos[v * 3 + 1]); w.Write(b.Pos[v * 3 + 2]);
                        w.Write(b.Nrm[v * 3]); w.Write(b.Nrm[v * 3 + 1]); w.Write(b.Nrm[v * 3 + 2]);
                        w.Write(b.Uv[v * 2]); w.Write(b.Uv[v * 2 + 1]);
                        if (b.HasCol) w.Write(b.Col[v]);
                    }
                    foreach (var i in b.Idx) w.Write(i);
                }
            }
            bool hasCol = colCells.TryGetValue(key, out var col);
            if (hasCol)
            {
                using var fs = File.Create(Path.Combine(outDir, "col", $"{id}.bin"));
                using var w = new BinaryWriter(fs);
                w.Write((uint)(col.v.Count / 3)); w.Write((uint)col.i.Count);
                foreach (var f in col.v) w.Write(f);
                foreach (var i in col.i) w.Write(i);
            }
            usedTextures.UnionWith(cellTex);
            cellList.Add(new JsonObject
            {
                ["id"] = id, ["x"] = key.Item1 * cellSize, ["z"] = key.Item2 * cellSize,
                ["render"] = batches != null, ["collision"] = hasCol, ["triangles"] = cellTris,
                ["textures"] = new JsonArray(cellTex.Order().Select(t => (JsonNode)t).ToArray()),
                ["min"] = batches != null ? new JsonArray(bmin.X, bmin.Y, bmin.Z) : null,
                ["max"] = batches != null ? new JsonArray(bmax.X, bmax.Y, bmax.Z) : null,
            });
        }

        // Textures
        int written = 0;
        var missingTex = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var name in usedTextures)
        {
            if (!textures.TryGetValue(name, out var t)) { missingTex.Add(name); continue; }
            if (WriteTexture(t, Path.Combine(outDir, "tex", Safe(name) + ".gtx"), maxTex)) written++;
            else missingTex.Add(name + $"({t.Format})");
        }

        var matJson = new JsonArray(matList.Select(m => (JsonNode)new JsonObject
        {
            ["shader"] = m.Shader,
            ["diffuse"] = m.Diffuse != null && !missingTex.Contains(m.Diffuse) ? Safe(m.Diffuse) : null,
            ["normal"] = m.Normal != null && !missingTex.Contains(m.Normal) ? Safe(m.Normal) : null,
            ["emissive"] = m.Emissive, ["blend"] = m.Blend, ["mask"] = m.Mask,
        }).ToArray());
        // Spawn at the road node nearest the middle, or the middle itself
        var spawn = new JsonArray(0.0, 30.0, 0.0);
        if (roads.nodes.Count > 0)
        {
            var best = roads.nodes.OrderBy(n => n.X * n.X + n.Z * n.Z).First();
            spawn = new JsonArray(best.X, best.Y + 1, best.Z);
        }
        var manifest = new JsonObject
        {
            ["origin"] = new JsonArray(origin.X, origin.Y, origin.Z),
            ["cellSize"] = cellSize,
            ["spawn"] = spawn,
            ["cells"] = cellList,
            ["materials"] = matJson,
            ["stats"] = new JsonObject
            {
                ["entities"] = placed.Count, ["missingEntities"] = missing, ["triangles"] = triangles,
                ["collisionTriangles"] = colTris, ["textures"] = written, ["roadNodes"] = roads.nodes.Count,
                ["roadsDerived"] = deriveRoads, ["croppedCells"] = cropped.Count,
                ["water"] = waterTris == 0 ? null : new JsonObject
                {
                    ["triangles"] = waterTris, ["area"] = Math.Round(waterArea), ["minY"] = waterMinY, ["maxY"] = waterMaxY,
                    ["textures"] = new JsonArray(waterTex.Order().Select(t => (JsonNode)t).ToArray()), ["dropped"] = dropWater,
                },
            },
        };
        var propCost = placed.Where(p => props.Contains(p.e.CEntityDef.archetypeName))
            .GroupBy(p => JenkIndex.GetString(p.e.CEntityDef.archetypeName))
            .Select(g => (name: g.Key, count: g.Count(), tris: ModelsFor(g.First().d, true).Sum(x => (x.Geometries ?? []).Sum(q => (long)q.IndicesCount / 3))))
            .OrderByDescending(x => x.count * x.tris)
            .ToDictionary(x => x.name, x => $"{x.count} x {x.tris}");
        File.WriteAllText(Path.Combine(outDir, "props.json"), JsonSerializer.Serialize(propCost, new JsonSerializerOptions { WriteIndented = true }));
        File.WriteAllText(Path.Combine(outDir, "missing.json"), JsonSerializer.Serialize(missingNames.OrderByDescending(kv => kv.Value).ToDictionary(), new JsonSerializerOptions { WriteIndented = true }));
        File.WriteAllText(Path.Combine(outDir, "manifest.json"), manifest.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        Console.WriteLine($"{outDir}: {placed.Count} entities ({missing} missing: {string.Join(",", missingNames.Keys.Take(8))}), {triangles} tris, {cellList.Count} cells, {colTris} collision tris, {written} textures ({missingTex.Count} missing: {string.Join(",", missingTex.Take(10))}), {roads.nodes.Count} road nodes");
    }

    const int PropTriangles = 15000;
    const float DetailRadius = 8; // m: entities smaller than this are detail (distance-culled in the game)
    const float Vox = 8; // m: voxel size for collision coverage
    const long VoxelStepY = 1L << 21;

    static long Voxel(Vector3 p) => VoxelKey((int)MathF.Floor(p.X / Vox), (int)MathF.Floor(p.Y / Vox), (int)MathF.Floor(p.Z / Vox));
    static long VoxelKey(int x, int y, int z) => ((long)(x & 0x1FFFFF) << 42) | ((long)(z & 0x1FFFFF) << 0) | ((long)(y & 0x1FFFFF) << 21);

    /// <summary>Mark every voxel a triangle's bounding box touches (large ground triangles: capped).</summary>
    static void MarkVoxels(HashSet<long> set, Vector3 a, Vector3 b, Vector3 c)
    {
        var lo = Vector3.Min(a, Vector3.Min(b, c)); var hi = Vector3.Max(a, Vector3.Max(b, c));
        int x0 = (int)MathF.Floor(lo.X / Vox), x1 = (int)MathF.Floor(hi.X / Vox);
        int y0 = (int)MathF.Floor(lo.Y / Vox), y1 = (int)MathF.Floor(hi.Y / Vox);
        int z0 = (int)MathF.Floor(lo.Z / Vox), z1 = (int)MathF.Floor(hi.Z / Vox);
        if ((long)(x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > 20000) { set.Add(Voxel((a + b + c) / 3)); return; }
        for (int x = x0; x <= x1; x++) for (int y = y0; y <= y1; y++) for (int z = z0; z <= z1; z++) set.Add(VoxelKey(x, y, z));
    }

    /// <summary>Each bone's model-space matrix (bones are stored relative to their parent).</summary>
    static Matrix[] BoneMatrices(DrawableBase d)
    {
        var bones = d.Skeleton?.Bones?.Items;
        if (bones == null) return [];
        var result = new Matrix[bones.Length];
        for (int i = 0; i < bones.Length; i++)
        {
            var b = bones[i];
            var scale = b.Scale == Vector3.Zero ? Vector3.One : b.Scale;
            var local = Matrix.Scaling(scale) * Matrix.RotationQuaternion(b.Rotation) * Matrix.Translation(b.Translation);
            result[i] = b.ParentIndex >= 0 && b.ParentIndex < i ? local * result[b.ParentIndex] : local;
        }
        return result;
    }

    /// <summary>The map's own models at full detail. Props (trees, lights) sit in their thousands, so take the most
    /// detailed LOD under a triangle budget; increased to 15000 to preserve high-quality tree geometry.</summary>
    static DrawableModel[] ModelsFor(DrawableBase d, bool prop)
    {
        var m = d.DrawableModels;
        if (m == null) return [];
        if (!prop) return m.High ?? [];
        DrawableModel[][] chain = [m.High, m.Med, m.Low, m.VLow];
        DrawableModel[] last = [];
        foreach (var lod in chain)
        {
            if (lod == null || lod.Length == 0) continue;
            last = lod;
            if (lod.Sum(x => (x.Geometries ?? []).Sum(g => (long)g.IndicesCount / 3)) <= PropTriangles) return lod;
        }
        return last;
    }

    /// <summary>Some tools name textures like files ("pack:/5a4b2b38.dds") while shaders refer to them as "5a4b2b38".</summary>
    static string TexKey(string name)
    {
        var k = name[(name.LastIndexOfAny(['/', '\\']) + 1)..];
        return k.EndsWith(".dds", StringComparison.OrdinalIgnoreCase) ? k[..^4] : k;
    }

    static string Safe(string name) => string.Concat(name.ToLowerInvariant().Select(c => char.IsLetterOrDigit(c) || c is '_' or '-' ? c : '_'));

    static MaterialInfo MaterialFor(ShaderFX s, Dictionary<string, MaterialInfo> materials)
    {
        var shader = ShaderNames.Of(s);
        string diffuse = null, normal = null;
        var pl = s?.ParametersList;
        for (int i = 0; i < (pl?.Parameters?.Length ?? 0); i++)
        {
            if (pl.Parameters[i].Data is not TextureBase tb || string.IsNullOrEmpty(tb.Name)) continue;
            var p = pl.Hashes[i].ToString().ToLowerInvariant();
            if (p == "diffusesampler" || (diffuse == null && p.Contains("diffuse"))) diffuse = tb.Name;
            else if (p == "bumpsampler" && !tb.Name.Contains("blank")) normal = tb.Name;
        }
        var key = $"{shader}|{diffuse}|{normal}";
        if (materials.TryGetValue(key, out var m)) return m;
        m = new MaterialInfo
        {
            Index = materials.Count, Shader = shader, Diffuse = diffuse, Normal = normal,
            Emissive = shader.Contains("emissive"),
            Blend = shader.Contains("alpha") || shader.Contains("decal") || shader.Contains("glass"),
            Mask = shader.Contains("cutout") || shader.Contains("trees") || shader.Contains("grass"),
        };
        return materials[key] = m;
    }

    /// <summary>DXT textures stay compressed (the GPU reads them directly); anything else is decoded to RGBA8.</summary>
    static bool WriteTexture(Texture t, string path, int maxTex)
    {
        uint format = t.Format switch
        {
            TextureFormat.D3DFMT_DXT1 => 1u,
            TextureFormat.D3DFMT_DXT3 => 3u,
            TextureFormat.D3DFMT_DXT5 => 5u,
            _ => 0u,
        };
        int skip = 0;
        while (skip < t.Levels - 1 && Math.Max(t.Width, t.Height) >> skip > maxTex) skip++;
        int w = Math.Max(1, t.Width >> skip), h = Math.Max(1, t.Height >> skip);
        using var ms = new MemoryStream();
        int mips = 0;
        if (format != 0)
        {
            var data = t.Data?.FullData;
            if (data == null) return false;
            int block = format == 1 ? 8 : 16;
            int offset = 0;
            for (int l = 0; l < t.Levels; l++)
            {
                int lw = Math.Max(1, t.Width >> l), lh = Math.Max(1, t.Height >> l);
                int size = Math.Max(1, (lw + 3) / 4) * Math.Max(1, (lh + 3) / 4) * block;
                if (offset + size > data.Length) break;
                if (l >= skip) { ms.Write(data, offset, size); mips++; }
                offset += size;
            }
        }
        else
        {
            byte[] px;
            try { px = DDSIO.GetPixels(t, skip); } catch { px = null; }
            if (px == null) return false;
            for (int i = 0; i < px.Length; i += 4) (px[i], px[i + 2]) = (px[i + 2], px[i]); // CodeWalker decodes to BGRA
            ms.Write(px);
            mips = 1;
        }
        using var fs = File.Create(path);
        using var bw = new BinaryWriter(fs);
        bw.Write("GTX1"u8.ToArray());
        bw.Write(format);
        bw.Write((ushort)w); bw.Write((ushort)h); bw.Write((ushort)mips); bw.Write((ushort)0);
        bw.Write(ms.ToArray());
        return true;
    }

    /// <summary>A road graph derived from road surface triangles (game frame), in the roads.json shape.</summary>
    /** Entities at least this big (bounding radius, m) are ground or terrain: trimmed by --clip, not dropped whole. */
    const float ClipWhole = 40;

    /** The road graph less its nodes outside the --clip loops, and every link touching one. */
    static (List<Vector3> nodes, JsonObject json) ClipRoads((List<Vector3> nodes, JsonObject json) roads, Func<float, float, bool> inside)
    {
        var keep = new int[roads.nodes.Count];
        var nodes = new List<Vector3>();
        var flagsIn = roads.json["flags"]?.AsArray();
        var flags = new JsonArray();
        for (int i = 0; i < roads.nodes.Count; i++)
        {
            if (!inside(roads.nodes[i].X, roads.nodes[i].Z)) { keep[i] = -1; continue; }
            keep[i] = nodes.Count;
            nodes.Add(roads.nodes[i]);
            flags.Add(flagsIn != null && i < flagsIn.Count ? flagsIn[i]!.DeepClone() : 0);
        }
        var links = new JsonArray();
        foreach (var l in roads.json["links"]!.AsArray())
        {
            int a = (int)l![0]!, b = (int)l[1]!;
            if (keep[a] < 0 || keep[b] < 0) continue;
            links.Add(new JsonArray(keep[a], keep[b], l[2]!.DeepClone(), l[3]!.DeepClone()));
        }
        var json = new JsonObject
        {
            ["nodes"] = new JsonArray(nodes.Select(p => (JsonNode)new JsonArray(Math.Round(p.X, 2), Math.Round(p.Y, 2), Math.Round(p.Z, 2))).ToArray()),
            ["flags"] = flags,
            ["links"] = links,
        };
        return (nodes, json);
    }

    static (List<Vector3> nodes, JsonObject json) DerivedRoads(List<Vector3> tris)
    {
        var (nodes, links) = RoadDerive.Build(tris);
        var json = new JsonObject
        {
            ["nodes"] = new JsonArray(nodes.Select(p => (JsonNode)new JsonArray(Math.Round(p.X, 2), Math.Round(p.Y, 2), Math.Round(p.Z, 2))).ToArray()),
            ["flags"] = new JsonArray(nodes.Select(_ => (JsonNode)0).ToArray()),
            ["links"] = new JsonArray(links.Select(l => (JsonNode)new JsonArray(l.a, l.b, l.lanesAB, l.lanesBA)).ToArray()),
            ["derived"] = true,
        };
        return (nodes, json);
    }

    /// <summary>Vehicle path nodes → a plain graph (positions in the game frame).</summary>
    static (List<Vector3> nodes, JsonObject json) Roads(ModFiles mod, Func<Vector3, Vector3> toGame)
    {
        var ynds = mod.Ynds.Values.Select(p => { var y = new YndFile(); y.Load(File.ReadAllBytes(p)); return y; }).ToList();
        var index = new Dictionary<(ushort, ushort), int>();
        var nodes = new List<Vector3>();
        var flags = new JsonArray();
        foreach (var y in ynds)
            foreach (var n in y.Nodes ?? [])
            {
                // Pedestrian nodes aren't roads
                if (n.IsPedNode) continue;
                index[(n.AreaID, n.NodeID)] = nodes.Count;
                nodes.Add(toGame(n.Position));
                flags.Add((int)n.Flags0.Value | ((int)n.Flags1.Value << 8) | ((int)n.Flags2.Value << 16) | ((int)n.Flags3.Value << 24));
            }
        // Links come from the raw link table (the resolved YndLink objects need CodeWalker's world cache)
        var links = new JsonArray();
        var seen = new HashSet<(int, int)>();
        foreach (var y in ynds)
        {
            var raw = y.NodeDictionary?.Links ?? [];
            foreach (var n in y.Nodes ?? [])
            {
                if (!index.TryGetValue((n.AreaID, n.NodeID), out var a)) continue;
                for (int k = 0; k < n.LinkCount && n.LinkID + k < raw.Length; k++)
                {
                    var l = raw[n.LinkID + k];
                    if (!index.TryGetValue((l.AreaID, l.NodeID), out var b) || a == b) continue;
                    if (!seen.Add((Math.Min(a, b), Math.Max(a, b)))) continue;
                    // Lanes a→b and b→a
                    links.Add(new JsonArray(a, b, (l.Flags2.Value >> 5) & 7, (l.Flags2.Value >> 2) & 7));
                }
            }
        }
        var json = new JsonObject
        {
            ["nodes"] = new JsonArray(nodes.Select(p => (JsonNode)new JsonArray(Math.Round(p.X, 2), Math.Round(p.Y, 2), Math.Round(p.Z, 2))).ToArray()),
            ["flags"] = flags,
            ["links"] = links,
        };
        return (nodes, json);
    }
}
