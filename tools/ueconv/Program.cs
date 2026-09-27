// Unreal Engine 4 cooked content (a packaged game's .pak) → Open Horizon map data. See UeMap.cs.
//
//   ueconv ls <Content/Paks dir> [filter]           list the package paths inside the paks
//   ueconv level <root> <level path>                  the actors of one level and what they place
//   ueconv map <root> <level path> <out dir> [--xodr <file.xodr>] [--tiles <regex>]   the level and everything
//                                                     it streams in, as the game's map data (UeMap.cs);
//                                                     --tiles: only a large map's tiles matching (a test)
//   ueconv mesh <root> <mesh path>                    a static mesh's materials, and each LOD's UV ranges
//   ueconv tex <root> <texture path>                  a texture's format and mips
//   ueconv json <root> <package path>                 a package's exports, as CUE4Parse reads them
// <root> holds <Project>/Content (cooked, loose files) and Engine/Content.
using CUE4Parse.Encryption.Aes;
using CUE4Parse.FileProvider;
using CUE4Parse.FileProvider.Objects;
using CUE4Parse.UE4.Assets;
using CUE4Parse.UE4.Assets.Exports;
using CUE4Parse.UE4.Assets.Exports.Component;
using CUE4Parse.UE4.Assets.Exports.Component.StaticMesh;
using CUE4Parse.UE4.Objects.Core.Misc;
using CUE4Parse.UE4.Objects.Engine;
using CUE4Parse.UE4.Versions;
using CUE4Parse.UE4.Objects.Core.Math;

/**
 * Materials and textures loaded once. CUE4Parse loads a package afresh on every request, and CARLA gives
 * nearly every placed building its own material instance: each loaded its own copy of its parents (4 MB
 * for a master material with its shader map), so one Town 13 tile held 8 GB of copies. Meshes and levels
 * are big and loaded once anyway: not kept.
 */
class CachedProvider(DirectoryInfo dir, DirectoryInfo[] extra, SearchOption search, VersionContainer versions, StringComparer comparer)
    : DefaultFileProvider(dir, extra, search, versions, comparer)
{
    readonly Dictionary<string, IPackage> cache = new(StringComparer.OrdinalIgnoreCase);
    public override IPackage LoadPackage(GameFile file)
    {
        if (cache.TryGetValue(file.Path, out var package)) return package;
        package = base.LoadPackage(file);
        if (package is Package p && p.ExportMap.All(e => e.ClassName.StartsWith("Material") || e.ClassName.StartsWith("Texture"))) cache[file.Path] = package;
        return package;
    }
}

static class Program
{
    public static DefaultFileProvider Open(string paks)
    {
        // A packaged game's loose cooked files: <root>/<Project>/Content/… (the game, as /Game) and
        // <root>/Engine/Content/… (as /Engine)
        var root = new DirectoryInfo(paks);
        var project = root.GetDirectories().First(d => d.Name != "Engine" && Directory.Exists(Path.Combine(d.FullName, "Content")));
        var extra = new[] { new DirectoryInfo(Path.Combine(root.FullName, "Engine")) }.Where(d => d.Exists).ToArray();
        var provider = new CachedProvider(project, extra, SearchOption.AllDirectories, new VersionContainer(EGame.GAME_UE4_26), StringComparer.OrdinalIgnoreCase);
        provider.Initialize();
        provider.SubmitKey(new FGuid(), new FAesKey(new byte[32]));
        provider.Mount();
        return provider;
    }

    /** A level by its package path (CarlaUE4/Content/…/Town12 or /Game/…/Town12, with or without .umap). */
    public static UWorld LoadWorld(DefaultFileProvider p, string path)
    {
        path = path.Replace(".umap", "");
        var name = path[(path.LastIndexOf('/') + 1)..];
        return p.LoadPackageObject<UWorld>($"{path}.{name}");
    }

    static int Main(string[] args)
    {
        if (args.Length >= 2 && args[0] == "ls")
        {
            var p = Open(args[1]);
            var filter = args.Length > 2 ? args[2] : "";
            foreach (var f in p.Files.Keys.Where(k => k.Contains(filter, StringComparison.OrdinalIgnoreCase)).Order()) Console.WriteLine(f);
            return 0;
        }
        if (args.Length >= 3 && args[0] == "level")
        {
            var p = Open(args[1]);
            var world = LoadWorld(p, args[2]);
            var level = world.PersistentLevel.Load<ULevel>();
            Console.WriteLine($"{args[2]}: {level.Actors.Length} actors, {world.StreamingLevels?.Length ?? 0} streaming levels");
            foreach (var s in world.StreamingLevels ?? []) Console.WriteLine($"  streaming: {s.Load()?.GetOrDefault<object>("WorldAsset")}");
            var kinds = new Dictionary<string, int>();
            int shown = 0;
            foreach (var a in level.Actors)
            {
                var actor = a?.Load();
                if (actor == null) continue;
                kinds[actor.ExportType] = kinds.GetValueOrDefault(actor.ExportType) + 1;
                if (shown++ < 15)
                {
                    Console.WriteLine($"  {actor.ExportType} {actor.Name}");
                    foreach (var prop in actor.Properties.Take(8)) Console.WriteLine($"     .{prop.Name} = {prop.Tag?.GenericValue?.ToString()?[..Math.Min(120, prop.Tag?.GenericValue?.ToString()?.Length ?? 0)]}");
                }
            }
            foreach (var (k, n) in kinds.OrderByDescending(kv => kv.Value)) Console.WriteLine($"  {n,6} {k}");
            return 0;
        }
        if (args.Length >= 3 && args[0] == "mesh")
        {
            // A static mesh's materials and every texture CUE4Parse finds for each
            var p = Open(args[1]);
            var path = args[2].Replace(".uasset", "");
            var sm = p.LoadPackageObject<CUE4Parse.UE4.Assets.Exports.StaticMesh.UStaticMesh>($"{path}.{path[(path.LastIndexOf('/') + 1)..]}");
            foreach (var slot in sm.StaticMaterials)
            {
                var mi = slot.MaterialInterface?.Load<CUE4Parse.UE4.Assets.Exports.Material.UMaterialInterface>();
                Console.WriteLine($"slot {slot.MaterialSlotName}: {mi?.GetPathName()} ({mi?.ExportType})");
                if (mi == null) continue;
                var mp = new CUE4Parse.UE4.Assets.Exports.Material.CMaterialParams2();
                mi.GetParams(mp, CUE4Parse.UE4.Assets.Exports.Material.EMaterialDepth.AllLayers);
                foreach (var (k, v) in mp.Textures) Console.WriteLine($"   tex {k} = {(v as CUE4Parse.UE4.Assets.Exports.UObject)?.GetPathName() ?? v?.ToString()}");
                foreach (var (k, v) in mp.Colors.Take(6)) Console.WriteLine($"   color {k} = {v}");
                foreach (var (k, v) in mp.Scalars.Take(20)) Console.WriteLine($"   scalar {k} = {v}");
                Console.WriteLine($"   blend {mp.BlendMode}");
                var ok1 = mp.TryGetTexture2d(out var d1, CUE4Parse.UE4.Assets.Exports.Material.CMaterialParams2.Diffuse[0]);
                var ok2 = mp.TryGetTexture2d(out var d2, CUE4Parse.UE4.Assets.Exports.Material.CMaterialParams2.FallbackDiffuse);
                Console.WriteLine($"   TryGet Diffuse[0]: {ok1} {d1?.GetType().Name} {d1?.Name}; fallback: {ok2} {d2?.GetType().Name} {d2?.Name}; Diffuse[0] = {string.Join(",", CUE4Parse.UE4.Assets.Exports.Material.CMaterialParams2.Diffuse[0].Take(12))}");
                if (mp.Textures.TryGetValue("PM_Diffuse", out var raw)) Console.WriteLine($"   raw PM_Diffuse: {raw.GetType().Name}");
                for (var cur = mi as CUE4Parse.UE4.Assets.Exports.Material.UMaterialInstance; cur != null; cur = cur.Parent as CUE4Parse.UE4.Assets.Exports.Material.UMaterialInstance)
                    Console.WriteLine($"   parent chain: {cur.Parent?.GetPathName()}");
            }
            // Each LOD's sections: their UV ranges and texel density (UV units per metre, from the
            // triangles' 3D and UV areas): what a texture is stretched over
            var lods = sm.RenderData?.LODs ?? [];
            for (int l = 0; l < lods.Length; l++)
            {
                var lod = lods[l];
                if (lod.PositionVertexBuffer == null) continue;
                var pos = lod.PositionVertexBuffer.Verts;
                var uvs = lod.VertexBuffer!.UV;
                var idx = lod.IndexBuffer!.Buffer!;
                Console.WriteLine($"LOD {l}{(lod.SkipLod ? " (skipped)" : "")}: {lod.Sections.Sum(s => s.NumTriangles)} tris, {pos.Length} verts, {lod.VertexBuffer.NumTexCoords} UV channels");
                foreach (var s in lod.Sections)
                    for (int c = 0; c < Math.Min(2, lod.VertexBuffer.NumTexCoords); c++)
                    {
                        var us = new List<float>(); var vs = new List<float>();
                        double area = 0, uvArea = 0;
                        int wild = 0; // triangles with a UV out past ±1000 (half-float overflow)
                        for (int t = 0; t < s.NumTriangles; t++)
                        {
                            var (a, b, d) = (idx[s.FirstIndex + t * 3], idx[s.FirstIndex + t * 3 + 1], idx[s.FirstIndex + t * 3 + 2]);
                            var (ta, tb, td) = (uvs[a].UV[c], uvs[b].UV[c], uvs[d].UV[c]);
                            if (new[] { ta, tb, td }.Any(uv => Math.Abs(uv.U) > 1000 || Math.Abs(uv.V) > 1000)) { wild++; continue; }
                            foreach (var uv in new[] { ta, tb, td }) { us.Add(uv.U); vs.Add(uv.V); }
                            var (pa, pb, pd) = (pos[a], pos[b], pos[d]);
                            var cr = (pb - pa) ^ (pd - pa);
                            area += Math.Sqrt(cr.X * (double)cr.X + cr.Y * (double)cr.Y + cr.Z * (double)cr.Z) / 2 / 1e4;
                            uvArea += Math.Abs((tb.U - ta.U) * (td.V - ta.V) - (td.U - ta.U) * (tb.V - ta.V)) / 2;
                        }
                        us.Sort(); vs.Sort();
                        // Triangles wound against their vertex normals (front: (v2 - v0) × (v1 - v0) in Unreal's frame)
                        int against = 0, faced = 0, walls = 0, sideways = 0;
                        if (c == 0)
                            for (int t = 0; t < s.NumTriangles; t++)
                            {
                                var (a, b, d) = (idx[s.FirstIndex + t * 3], idx[s.FirstIndex + t * 3 + 1], idx[s.FirstIndex + t * 3 + 2]);
                                var f = (pos[d] - pos[a]) ^ (pos[b] - pos[a]);
                                var n = (FVector)uvs[a].Normal[2] + (FVector)uvs[b].Normal[2] + (FVector)uvs[d].Normal[2];
                                double fl = Math.Sqrt(f.X * (double)f.X + f.Y * (double)f.Y + f.Z * (double)f.Z), nl = Math.Sqrt(n.X * (double)n.X + n.Y * (double)n.Y + n.Z * (double)n.Z);
                                if (fl < 1 || nl < 1e-3) continue;
                                faced++;
                                if ((f.X * (double)n.X + f.Y * (double)n.Y + f.Z * (double)n.Z) / (fl * nl) < -0.9) against++;
                                // Walls whose normals turn 45–135° from the face about the vertical (smoothing across corners)
                                if (Math.Abs(f.Z) / fl >= 0.25) continue;
                                walls++;
                                double hn = Math.Sqrt(n.X * (double)n.X + n.Y * (double)n.Y), hf = Math.Sqrt(f.X * (double)f.X + f.Y * (double)f.Y);
                                if (hn > 1e-3 && Math.Abs((f.X * (double)n.X + f.Y * (double)n.Y) / (hn * hf)) < Math.Sqrt(0.5)) sideways++;
                            }
                        if (faced > 0) Console.WriteLine($"   section mat {s.MaterialIndex}: {against} of {faced} triangles wound against their normals; {sideways} of {walls} walls with normals turned 45–135°");
                        string Pc(List<float> l) => l.Count == 0 ? "-" : $"{l[0]:F2} [{l[l.Count / 100]:F2} {l[l.Count / 2]:F2} {l[l.Count * 99 / 100]:F2}] {l[^1]:F2}";
                        Console.WriteLine($"   section mat {s.MaterialIndex}: {s.NumTriangles} tris ({wild} wild), UV{c} u {Pc(us)} v {Pc(vs)}, {area:F0} m², {Math.Sqrt(uvArea / Math.Max(1e-9, area)):F3} UV/m");
                    }
            }
            var box = sm.RenderData?.Bounds;
            Console.WriteLine($"bounds: extent {box?.BoxExtent} (cm), radius {box?.SphereRadius / 100:F1} m");
            return 0;
        }
        if (args.Length >= 3 && args[0] == "json")
        {
            // A package's exports as CUE4Parse reads them: a material's parameters and streaming data, a
            // component's properties
            var p = Open(args[1]);
            var path = args[2].EndsWith(".umap") || args[2].EndsWith(".uasset") ? args[2] : args[2] + ".uasset";
            Console.WriteLine(Newtonsoft.Json.JsonConvert.SerializeObject(p.LoadPackage(path).GetExports(), Newtonsoft.Json.Formatting.Indented));
            return 0;
        }
        if (args.Length >= 3 && args[0] == "tex")
        {
            var p = Open(args[1]);
            var path = args[2].Replace(".uasset", "");
            var t = p.LoadPackageObject<CUE4Parse.UE4.Assets.Exports.Texture.UTexture2D>($"{path}.{path[(path.LastIndexOf('/') + 1)..]}");
            Console.WriteLine($"{t.Name}: {t.Format}, {t.PlatformData.Mips.Length} mips, normal map {t.IsNormalMap}");
            for (int i = 0; i < t.PlatformData.Mips.Length; i++)
            {
                var m = t.PlatformData.Mips[i];
                Console.WriteLine($"  mip {i}: {m.SizeX}x{m.SizeY} valid {m.EnsureValidBulkData(t.MipDataProvider, i)} bytes {m.BulkData?.Data?.Length ?? -1} flags {m.BulkData?.Header.BulkDataFlags}");
            }
            return 0;
        }
        if (args.Length >= 4 && args[0] == "map")
        {
            var i = Array.IndexOf(args, "--xodr");
            var t = Array.IndexOf(args, "--tiles");
            UeMap.Write(Open(args[1]), args[2], i > 0 ? args[i + 1] : null, args[3], t > 0 ? args[t + 1] : null);
            return 0;
        }
        Console.Error.WriteLine("usage: ueconv ls <paks> [filter] | level <paks> <level>");
        return 1;
    }
}
