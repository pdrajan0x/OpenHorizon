// Map conversion: GTA V map mods → streaming cells for the game (see MapWriter.cs for the format).
//   gta5conv map <unpacked mod dir> --inspect [ydr name]   list what's inside
//   gta5conv map <unpacked mod dir> <outdir> [--cell 200] [--max-tex 1024] [--props <prop mod dir>]…
using CodeWalker.GameFiles;
using SharpDX;

static class MapExport
{
    public static void Run(string[] args)
    {
        var inputs = new List<string>();
        bool inspect = false;
        var props = new List<string>();
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--inspect") inspect = true;
            else if (args[i] == "--props") props.Add(args[++i]);
            else if (args[i] is "--cell" or "--max-tex") i++;
            else inputs.Add(args[i]);
        }
        var mod = ModFiles.Scan(inputs[0]);
        foreach (var dir in props) mod.AddProps(ModFiles.Scan(dir));
        if (inspect && inputs.Count > 1) { InspectGeoms(mod, inputs[1]); return; }
        if (inspect) { Inspect(mod); return; }
        MapWriter.Write(mod, inputs[1], args);
    }

    static void InspectGeoms(ModFiles mod, string name)
    {
        var y = new YdrFile(); y.Load(File.ReadAllBytes(mod.Ydrs[name]));
        foreach (var model in y.Drawable.DrawableModels?.High ?? [])
            foreach (var g in model.Geometries ?? [])
            {
                var pl = g.Shader?.ParametersList;
                var texs = new List<string>();
                for (int i = 0; i < (pl?.Parameters?.Length ?? 0); i++)
                    if (pl.Parameters[i].Data is TextureBase tb) texs.Add(pl.Hashes[i] + "=" + tb.Name);
                var vd = g.VertexData;
                float zmin = float.MaxValue, zmax = float.MinValue; double area = 0;
                var idx = g.IndexBuffer.Indices;
                for (int v = 0; v < vd.VertexCount; v++) { var p = vd.GetVector3(v, 0); zmin = Math.Min(zmin, p.Z); zmax = Math.Max(zmax, p.Z); }
                for (int i = 0; i + 2 < g.IndicesCount; i += 3)
                {
                    var a = vd.GetVector3(idx[i], 0); var b = vd.GetVector3(idx[i + 1], 0); var c = vd.GetVector3(idx[i + 2], 0);
                    area += Vector3.Cross(b - a, c - a).Length() / 2;
                }
                Console.WriteLine($"{ShaderNames.Of(g.Shader)} tris={g.IndicesCount / 3} verts={vd.VertexCount} z={zmin:F1}..{zmax:F1} area={area:F0} flags={vd.Info.Flags:X} {string.Join(" ", texs)}");
            }
        var bound = y.Drawable.Bound;
        Console.WriteLine($"bound {bound?.Type} {bound?.BoxMin}..{bound?.BoxMax}");
        if (bound is BoundComposite bc)
            foreach (var ch in bc.Children?.data_items ?? [])
                if (ch is BoundGeometry bg) Console.WriteLine($"  child {ch.Type} polys={bg.Polygons?.Length} {bg.BoxMin}..{bg.BoxMax} mats={bg.Materials?.Length} T={ch.Transform.TranslationVector}");
    }

    static void Inspect(ModFiles mod)
    {
        foreach (var (name, path) in mod.Ymaps)
        {
            var y = new YmapFile(); y.Load(File.ReadAllBytes(path));
            Console.WriteLine($"YMAP {name}: entities={y.AllEntities?.Length} flags={y.CMapData.flags} contentFlags={y.CMapData.contentFlags} parent={JenkIndex.GetString(y.CMapData.parent)} ext={y.CMapData.entitiesExtentsMin}..{y.CMapData.entitiesExtentsMax}");
            foreach (var e in y.AllEntities ?? [])
            {
                var d = e.CEntityDef;
                Console.WriteLine($"   {JenkIndex.GetString(d.archetypeName),-32} pos={d.position} lod={d.lodLevel} parent={d.parentIndex} lodDist={d.lodDist} childLod={d.childLodDist} scale={d.scaleXY}/{d.scaleZ} flags={d.flags:X} rot={d.rotation}");
            }
        }
        foreach (var (name, path) in mod.Ytyps)
        {
            var y = new YtypFile(); y.Load(File.ReadAllBytes(path));
            Console.WriteLine($"YTYP {name}: archetypes={y.AllArchetypes?.Length}");
            foreach (var a in y.AllArchetypes ?? [])
                Console.WriteLine($"   {a.Name,-32} type={a.Type} drawDict={JenkIndex.GetString(a.DrawableDict)} txd={JenkIndex.GetString(a.TextureDict)} lodDist={a.LodDist} bb={a.BBMin}..{a.BBMax} flags={a._BaseArchetypeDef.flags:X} assetType={a._BaseArchetypeDef.assetType} phys={JenkIndex.GetString(a._BaseArchetypeDef.physicsDictionary)}");
        }
        foreach (var (name, path) in mod.Ydrs)
        {
            var y = new YdrFile(); y.Load(File.ReadAllBytes(path));
            var d = y.Drawable;
            var m = d?.DrawableModels;
            long tris(DrawableModel[] ms) => ms?.Sum(x => x.Geometries?.Sum(g => (long)g.IndicesCount / 3) ?? 0) ?? 0;
            var texNames = new HashSet<string>();
            foreach (var s in d?.ShaderGroup?.Shaders?.data_items ?? [])
            {
                var pl = s.ParametersList;
                for (int i = 0; i < (pl?.Parameters?.Length ?? 0); i++)
                    if (pl.Parameters[i].Data is TextureBase tb && tb.Name != null) texNames.Add(tb.Name);
            }
            var shaders = string.Join(",", (d?.ShaderGroup?.Shaders?.data_items ?? []).Select(ShaderNames.Of).Distinct());
            Console.WriteLine($"YDR {name}: bb={d?.BoundingBoxMin}..{d?.BoundingBoxMax} tris H={tris(m?.High)} M={tris(m?.Med)} L={tris(m?.Low)} VL={tris(m?.VLow)} lod={d?.LodDistHigh}/{d?.LodDistMed}/{d?.LodDistLow}/{d?.LodDistVlow} emb={d?.ShaderGroup?.TextureDictionary?.Textures?.Count} bound={d?.Bound?.Type} shaders={shaders} tex={texNames.Count}");
        }
        foreach (var (name, path) in mod.Ytds)
        {
            var y = new YtdFile(); y.Load(File.ReadAllBytes(path));
            var ts = y.TextureDict?.Textures?.data_items ?? [];
            Console.WriteLine($"YTD {name}: {ts.Length} textures, max {ts.Select(t => (int)Math.Max(t.Width, t.Height)).DefaultIfEmpty(0).Max()} px, formats {string.Join(",", ts.Select(t => t.Format.ToString()).Distinct())}");
            foreach (var g in ts.GroupBy(t => $"{t.Format} {t.Width}x{t.Height} L{t.Levels}").OrderByDescending(g => g.Count()))
                Console.WriteLine($"     {g.Count(),4} {g.Key}  e.g. {string.Join(",", g.Take(3).Select(t => t.Name))}");
        }
        foreach (var (name, path) in mod.Ybns)
        {
            var y = new YbnFile(); y.Load(File.ReadAllBytes(path));
            int polys = 0, verts = 0, geoms = 0;
            var types = new Dictionary<string, int>();
            void walk(Bounds b)
            {
                if (b is BoundComposite c) { foreach (var ch in c.Children?.data_items ?? []) if (ch != null) walk(ch); }
                else if (b is BoundGeometry g)
                {
                    geoms++; polys += g.Polygons?.Length ?? 0; verts += g.Vertices?.Length ?? 0;
                    foreach (var p in g.Polygons ?? []) { var t = p.Type.ToString(); types[t] = types.GetValueOrDefault(t) + 1; }
                }
                else { var t = b.Type.ToString(); types[t] = types.GetValueOrDefault(t) + 1; }
            }
            walk(y.Bounds);
            Console.WriteLine($"YBN {name}: {y.Bounds?.Type} bb={y.Bounds?.BoxMin}..{y.Bounds?.BoxMax} geoms={geoms} polys={polys} verts={verts} {string.Join(",", types.Select(kv => kv.Key + "=" + kv.Value))}");
        }
        foreach (var (name, path) in mod.Ynds)
        {
            var y = new YndFile(); y.Load(File.ReadAllBytes(path));
            Console.WriteLine($"YND {name}: nodes={y.Nodes?.Length} links={y.NodeDictionary?.Links?.Length} junctions={y.Junctions?.Length} bb={y.BBMin}..{y.BBMax}");
        }
    }
}

/// <summary>All GTA files of an unpacked mod, keyed by lowercase name without extension.</summary>
class ModFiles
{
    public readonly SortedDictionary<string, string> Ymaps = [], Ytyps = [], Ydrs = [], Ydds = [], Yfts = [], Ytds = [], Ybns = [], Ynds = [];
    public readonly List<string> Gtxds = [];
    public readonly HashSet<string> PropNames = [];

    public static ModFiles Scan(string dir)
    {
        var m = new ModFiles();
        foreach (var path in Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories).Order())
        {
            var ext = Path.GetExtension(path).ToLowerInvariant();
            var name = Path.GetFileNameWithoutExtension(path).ToLowerInvariant();
            JenkIndex.Ensure(name);
            var table = ext switch
            {
                ".ymap" => m.Ymaps, ".ytyp" => m.Ytyps, ".ydr" => m.Ydrs, ".ydd" => m.Ydds,
                ".yft" => m.Yfts, ".ytd" => m.Ytds, ".ybn" => m.Ybns, ".ynd" => m.Ynds, _ => null,
            };
            if (table != null) table.TryAdd(name, path);
            else if (Path.GetFileName(path).ToLowerInvariant() is "gtxd.meta" or "gtxd.ymt") m.Gtxds.Add(path);
        }
        return m;
    }

    /// <summary>Add another mod's models and textures (props, trees) for archetypes this map uses but doesn't ship.</summary>
    public void AddProps(ModFiles other)
    {
        foreach (var (k, v) in other.Ydrs) if (Ydrs.TryAdd(k, v)) PropNames.Add(k);
        foreach (var (k, v) in other.Ydds) Ydds.TryAdd(k, v);
        foreach (var (k, v) in other.Yfts) if (!Ydrs.ContainsKey(k) && Yfts.TryAdd(k, v)) PropNames.Add(k);
        foreach (var (k, v) in other.Ytds) Ytds.TryAdd(k, v);
    }
}
