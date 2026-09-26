// Writes a GTA V map mod as streaming data for the game (public/mods/maps/<id>/):
//
//   manifest.json   origin, bounds, cell size, cells (with their textures), materials, spawn, stats
//   cells/<i>.bin   render geometry of one cell, merged per material (format below)
//   col/<i>.bin     collision triangles of one cell: u32 vertexCount, u32 indexCount, f32 xyz…, u32 idx…
//   tex/<name>.gtx  one texture: "GTX1", u32 format (1/3/5 = DXT1/3/5, 0 = RGBA8), u16 w, u16 h, u16 mips,
//                   u16 pad, then the mip chain (largest first)
//   roads.json      the path-node graph: nodes [[x,y,z]…] and links [[a, b, lanesAtoB, lanesBtoA]…]
//
// Cell .bin: u32 json length, JSON { batches: [{ material, vertices, indices }] }, padding to 4 bytes,
// then per batch: f32 position×3, f32 normal×3, f32 uv×2 per vertex, then u32 indices.
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
        public readonly List<uint> Idx = [];
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
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--cell") cellSize = float.Parse(args[++i]);
            if (args[i] == "--max-tex") maxTex = int.Parse(args[++i]);
        }
        Directory.CreateDirectory(Path.Combine(outDir, "cells"));
        Directory.CreateDirectory(Path.Combine(outDir, "col"));
        Directory.CreateDirectory(Path.Combine(outDir, "tex"));

        // Textures by name from every dictionary in the mod (and drawables' embedded ones, below)
        var textures = new Dictionary<string, Texture>(StringComparer.OrdinalIgnoreCase);
        foreach (var (_, path) in mod.Ytds)
        {
            var ytd = new YtdFile();
            ytd.Load(File.ReadAllBytes(path));
            foreach (var t in ytd.TextureDict?.Textures?.data_items ?? []) if (t?.Name != null) textures.TryAdd(t.Name, t);
        }

        // Drawables by name hash: loose .ydr files, and every entry of .ydd dictionaries
        var drawablePaths = mod.Ydrs.ToDictionary(kv => JenkHash.GenHash(kv.Key), kv => kv.Value);
        var drawables = new Dictionary<uint, DrawableBase>();
        foreach (var (_, path) in mod.Ydds)
        {
            var ydd = new YddFile();
            ydd.Load(File.ReadAllBytes(path));
            foreach (var (hash, d) in ydd.Dict ?? []) drawables.TryAdd(hash, d);
        }
        DrawableBase drawableFor(uint hash)
        {
            if (drawables.TryGetValue(hash, out var d)) return d;
            if (!drawablePaths.TryGetValue(hash, out var path)) return drawables[hash] = null;
            var ydr = new YdrFile();
            ydr.Load(File.ReadAllBytes(path));
            foreach (var t in ydr.Drawable?.ShaderGroup?.TextureDictionary?.Textures?.data_items ?? [])
                if (t?.Name != null) textures.TryAdd(t.Name, t);
            return drawables[hash] = ydr.Drawable;
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
        var placed = new List<(YmapEntityDef e, DrawableBase d)>();
        int missing = 0;
        var missingNames = new HashSet<string>();
        foreach (var y in ymaps.Values)
            foreach (var e in y.AllEntities ?? [])
            {
                var lod = e.CEntityDef.lodLevel;
                if (lod is rage__eLodType.LODTYPES_DEPTH_SLOD1 or rage__eLodType.LODTYPES_DEPTH_SLOD2 or rage__eLodType.LODTYPES_DEPTH_SLOD3 or rage__eLodType.LODTYPES_DEPTH_SLOD4) continue;
                if (hasChildren.Contains(e)) continue;
                var name = JenkIndex.GetString(e.CEntityDef.archetypeName);
                if (name.Contains("slod") || name.EndsWith("_lod")) continue;
                var d = drawableFor(e.CEntityDef.archetypeName);
                if (d == null) { missing++; missingNames.Add(name); continue; }
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
        foreach (var (e, d) in placed)
        {
            var world = Matrix.Scaling(e.Scale) * Matrix.RotationQuaternion(e.Orientation) * Matrix.Translation(e.Position);
            foreach (var model in d.DrawableModels?.High ?? [])
                foreach (var g in model.Geometries ?? [])
                {
                    var vd = g.VertexData;
                    var idx = g.IndexBuffer?.Indices;
                    if (vd?.Info == null || idx == null) continue;
                    var mat = MaterialFor(g.Shader, materials);
                    var info = vd.Info;
                    bool has(int c) => ((info.Flags >> c) & 1) != 0;
                    var pos = new Vector3[vd.VertexCount];
                    var nrm = new Vector3[vd.VertexCount];
                    var uv = new Vector2[vd.VertexCount];
                    for (int v = 0; v < vd.VertexCount; v++)
                    {
                        pos[v] = toGame(Vector3.TransformCoordinate(vd.GetVector3(v, 0), world));
                        var n = has(3) ? info.GetComponentType(3) switch
                        {
                            VertexComponentType.Float3 => vd.GetVector3(v, 3),
                            VertexComponentType.RGBA8SNorm => (Vector3)vd.GetRGBA8SNorm(v, 3),
                            _ => Vector3.UnitZ,
                        } : Vector3.UnitZ;
                        // Some meshes carry zero-length normals; normalizing those gives NaN, which the
                        // renderer's bloom spreads over the whole screen
                        var tn = Vector3.TransformNormal(n, world);
                        nrm[v] = tn.LengthSquared() > 1e-12 && !float.IsNaN(tn.X) ? Axis.ToGame(Vector3.Normalize(tn)) : new Vector3(0, 1, 0);
                        if (has(6))
                            uv[v] = info.GetComponentType(6) switch
                            {
                                VertexComponentType.Float2 => vd.GetVector2(v, 6),
                                VertexComponentType.Half2 => new Vector2(vd.GetHalf2(v, 6).X, vd.GetHalf2(v, 6).Y),
                                _ => Vector2.Zero,
                            };
                    }
                    // Each triangle goes to the cell holding its centroid; vertices are copied per cell as needed
                    var remap = new Dictionary<(int, int), Dictionary<int, uint>>();
                    for (int i = 0; i + 2 < idx.Length && i + 2 < g.IndicesCount; i += 3)
                    {
                        var c = (pos[idx[i]] + pos[idx[i + 1]] + pos[idx[i + 2]]) / 3;
                        var key = ((int)MathF.Floor(c.X / cellSize), (int)MathF.Floor(c.Z / cellSize));
                        if (!cells.TryGetValue(key, out var cell)) cells[key] = cell = [];
                        if (!cell.TryGetValue(mat.Index, out var b)) cell[mat.Index] = b = new Batch();
                        if (!remap.TryGetValue(key, out var map)) remap[key] = map = [];
                        for (int k = 0; k < 3; k++)
                        {
                            int vi = idx[i + k];
                            if (!map.TryGetValue(vi, out var ni))
                            {
                                ni = (uint)(b.Pos.Count / 3);
                                b.Pos.AddRange([pos[vi].X, pos[vi].Y, pos[vi].Z]);
                                b.Nrm.AddRange([nrm[vi].X, nrm[vi].Y, nrm[vi].Z]);
                                b.Uv.AddRange([uv[vi].X, uv[vi].Y]);
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
        long colTris = 0;
        void addBounds(Bounds b)
        {
            if (b is BoundComposite comp) { foreach (var ch in comp.Children?.data_items ?? []) if (ch != null) addBounds(ch); return; }
            if (b is not BoundGeometry bg || bg.Polygons == null) return;
            foreach (var p in bg.Polygons)
            {
                if (p is not BoundPolygonTriangle t) continue;
                var a = toGame(bg.GetVertexPos(t.vertIndex1));
                var bb = toGame(bg.GetVertexPos(t.vertIndex2));
                var c = toGame(bg.GetVertexPos(t.vertIndex3));
                var m = (a + bb + c) / 3;
                var key = ((int)MathF.Floor(m.X / cellSize), (int)MathF.Floor(m.Z / cellSize));
                if (!colCells.TryGetValue(key, out var cc)) colCells[key] = cc = ([], []);
                var baseIndex = (uint)(cc.v.Count / 3);
                cc.v.AddRange([a.X, a.Y, a.Z, bb.X, bb.Y, bb.Z, c.X, c.Y, c.Z]);
                cc.i.AddRange([baseIndex, baseIndex + 1, baseIndex + 2]);
                colTris++;
            }
        }
        // Some mods ship one combined collision file as well as split ones; skip any bound that
        // contains several others, so the same surfaces aren't added twice
        var ybns = mod.Ybns.Values.Select(p => { var y = new YbnFile(); y.Load(File.ReadAllBytes(p)); return y; })
            .Where(y => y.Bounds != null).ToList();
        bool contains(Bounds a, Bounds b) => a != b
            && a.BoxMin.X <= b.BoxMin.X + 1 && a.BoxMin.Y <= b.BoxMin.Y + 1 && a.BoxMin.Z <= b.BoxMin.Z + 1
            && a.BoxMax.X >= b.BoxMax.X - 1 && a.BoxMax.Y >= b.BoxMax.Y - 1 && a.BoxMax.Z >= b.BoxMax.Z - 1;
        foreach (var y in ybns)
            if (ybns.Count(o => contains(y.Bounds, o.Bounds)) < 3) addBounds(y.Bounds);

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
                    header.Add(new JsonObject { ["material"] = mi, ["vertices"] = b.Pos.Count / 3, ["indices"] = b.Idx.Count });
                    cellTris += b.Idx.Count / 3;
                    var m = matList[mi];
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

        // Roads
        var roads = Roads(mod, toGame);
        File.WriteAllText(Path.Combine(outDir, "roads.json"), roads.json.ToJsonString());

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
            },
        };
        File.WriteAllText(Path.Combine(outDir, "manifest.json"), manifest.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        Console.WriteLine($"{outDir}: {placed.Count} entities ({missing} missing: {string.Join(",", missingNames.Take(8))}), {triangles} tris, {cellList.Count} cells, {colTris} collision tris, {written} textures ({missingTex.Count} missing: {string.Join(",", missingTex.Take(10))}), {roads.nodes.Count} road nodes");
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
