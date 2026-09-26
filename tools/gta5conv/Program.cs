// GTA V asset converter for Open Horizon: reads .yft/.ytd with CodeWalker.Core and writes .glb in the
// game's frame (+X forward, +Y up, +Z right). GTA's frame is +X right, +Y forward, +Z up, so every
// position and normal maps (x, y, z) → (y, z, x), a rotation (no mirroring).
//
//   gta5conv dump <file.yft>
//   gta5conv car <out.glb> <model.yft> [more.ytd ...] [--max-tex 2048]
//   gta5conv rpf <dlc.rpf> <outdir>          unpack an archive into loose files
//   gta5conv map ... / audio ... / tex ...   see MapExport.cs / AudioExport.cs / TexExport.cs
//
// Car output: one node per car part, named after the GTA bone it moves with (chassis, bonnet,
// door_dside_f, headlight_l…), plus wheel_lf/rf/lr/rr nodes centered on the wheel hubs. Material
// extras carry the GTA shader name and paint slot so the game can repaint the body.
using System.IO.Compression;
using System.Text.Json.Nodes;
using System.Xml;
using CodeWalker.GameFiles;
using CodeWalker.Utils;
using SharpDX;

static class Program
{
    static int Main(string[] args)
    {
        ShaderNames.Load();
        if (args.Length >= 2 && args[0] == "dump") { Dump.Run(args[1]); return 0; }
        if (args.Length >= 3 && args[0] == "car") { CarExport.Run(args[1..]); return 0; }
        if (args.Length >= 3 && args[0] == "rpf") { RpfExport.Run(args[1..]); return 0; }
        if (args.Length >= 2 && args[0] == "map") { MapExport.Run(args[1..]); return 0; }
        if (args.Length >= 2 && args[0] == "audio") { AudioExport.Run(args[1..]); return 0; }
        if (args.Length >= 2 && args[0] == "tex") { TexExport.Run(args[1..]); return 0; }
        Console.Error.WriteLine("usage: gta5conv dump <file.yft> | car <out.glb> <model.yft> [textures.ytd ...] [--max-tex N]");
        return 1;
    }
}

/// <summary>Shader names are stored as hashes; CodeWalker ships the list of real names.</summary>
static class ShaderNames
{
    public static void Load()
    {
        var path = Path.Combine(AppContext.BaseDirectory, "ShadersGen9Conversion.xml");
        var doc = new XmlDocument();
        doc.Load(path);
        foreach (XmlNode n in doc.SelectNodes("//Item/Name")!) JenkIndex.Ensure(n.InnerText.Trim().ToLowerInvariant());
        foreach (XmlNode n in doc.SelectNodes("//Item/FileName")!) JenkIndex.Ensure(n.InnerText.Trim().ToLowerInvariant());
    }

    public static string Of(ShaderFX s) => s == null ? "none" : JenkIndex.GetString(s.Name.Hash);
}

static class Axis
{
    /// <summary>GTA (right, forward, up) → game (forward, up, right).</summary>
    public static Vector3 ToGame(Vector3 v) => new(v.Y, v.Z, v.X);
}

static class Dump
{
    public static void Run(string path)
    {
        var yft = new YftFile();
        yft.Load(File.ReadAllBytes(path));
        var frag = yft.Fragment;
        var d = frag.Drawable;
        var m = d.DrawableModels;
        Console.WriteLine($"models: high={m?.High?.Length} med={m?.Med?.Length} low={m?.Low?.Length} vlow={m?.VLow?.Length}");
        var bones = d.Skeleton?.Bones?.Items;
        if (bones != null) for (int i = 0; i < bones.Length; i++) Console.WriteLine($"  bone[{i}] {bones[i].Name} parent={bones[i].ParentIndex} tag={bones[i].Tag} t={bones[i].Translation}");
        void models(string label, DrawableModel[] ms)
        {
            if (ms == null) return;
            foreach (var model in ms)
            {
                var bn = bones != null && model.BoneIndex < bones.Length ? bones[model.BoneIndex].Name : "?";
                var tris = model.Geometries?.Sum(g => (long)g.IndicesCount / 3) ?? 0;
                Console.WriteLine($"  {label} bone={bn} skin={model.HasSkin} geoms={model.Geometries?.Length} tris={tris}");
                foreach (var g in model.Geometries ?? []) Console.WriteLine($"     {ShaderNames.Of(g.Shader)} tris={g.IndicesCount / 3} decl={g.VertexData?.Info?.Types:X} flags={g.VertexData?.Info?.Flags}");
            }
        }
        models("HIGH", m?.High);
        models("MED", m?.Med);
        models("LOW", m?.Low);
        models("VLOW", m?.VLow);
        foreach (var c in frag.PhysicsLODGroup?.PhysicsLOD1?.Children?.data_items ?? [])
        {
            models($"CHILD tag={c.BoneTag}", c.Drawable1?.DrawableModels?.High);
        }
        var texs = d.ShaderGroup?.TextureDictionary?.Textures?.data_items;
        Console.WriteLine($"embedded textures: {texs?.Length}");
    }
}

static class CarExport
{
    // Front wheels come from the wheel_lf child drawable, rears from wheel_lr; the right side reuses them
    // turned 180° about the forward axis so the rim faces out (what the game itself does).
    static readonly (string name, ushort tag, bool front, bool right)[] Wheels =
    [
        ("wheel_lf", 27922, true, false), ("wheel_rf", 26418, true, true),
        ("wheel_lr", 27902, false, false), ("wheel_rr", 26398, false, true),
    ];

    public static void Run(string[] args)
    {
        var outPath = args[0];
        var yftPath = args[1];
        int maxTex = 2048;
        var ytds = new List<string>();
        for (int i = 2; i < args.Length; i++)
        {
            if (args[i] == "--max-tex") maxTex = int.Parse(args[++i]);
            else ytds.Add(args[i]);
        }

        var yft = new YftFile();
        yft.Load(File.ReadAllBytes(yftPath));
        var frag = yft.Fragment;
        var drawable = frag.Drawable;

        var textures = new Dictionary<string, Texture>(StringComparer.OrdinalIgnoreCase);
        void addDict(TextureDictionary td)
        {
            foreach (var t in td?.Textures?.data_items ?? []) if (t?.Name != null) textures.TryAdd(t.Name, t);
        }
        foreach (var path in ytds)
        {
            var ytd = new YtdFile();
            ytd.Load(File.ReadAllBytes(path));
            addDict(ytd.TextureDict);
        }
        addDict(drawable.ShaderGroup?.TextureDictionary);

        var gltf = new Gltf(textures, maxTex);
        var root = gltf.AddNode(Path.GetFileNameWithoutExtension(yftPath));

        // Body: every triangle goes to the part (bone) that its first vertex follows most
        var bones = drawable.Skeleton?.Bones?.Items ?? [];
        var boneMatrices = BoneMatrices(frag, bones);
        var parts = new SortedDictionary<string, List<(ShaderFX shader, Tri tri)>>();
        foreach (var model in drawable.DrawableModels?.High ?? [])
        {
            var skinned = model.HasSkin == 1;
            var modelMatrix = skinned || model.BoneIndex >= boneMatrices.Length ? Matrix.Identity : boneMatrices[model.BoneIndex];
            var modelBone = model.BoneIndex < bones.Length ? bones[model.BoneIndex].Name : "chassis";
            foreach (var g in model.Geometries ?? [])
            {
                foreach (var tri in Tri.Read(g, modelMatrix, skinned))
                {
                    var bone = skinned && tri.Bone >= 0 && tri.Bone < bones.Length ? bones[tri.Bone].Name : modelBone;
                    if (!parts.TryGetValue(bone, out var list)) parts[bone] = list = [];
                    list.Add((g.Shader, tri));
                }
            }
        }
        foreach (var (bone, tris) in parts)
        {
            var node = gltf.AddNode(bone, gltf.AddMesh(bone, tris));
            gltf.AddChild(root, node);
        }

        // Wheels
        var children = frag.PhysicsLODGroup?.PhysicsLOD1?.Children?.data_items ?? [];
        var wheelMeshes = new Dictionary<bool, (int mesh, float radius, float width)>();
        foreach (var front in new[] { true, false })
        {
            var tag = front ? (ushort)27922 : (ushort)27902;
            var child = children.FirstOrDefault(c => c.BoneTag == tag && c.Drawable1?.DrawableModels?.High?.Length > 0)
                ?? children.FirstOrDefault(c => (c.BoneTag == 27922 || c.BoneTag == 27902) && c.Drawable1?.DrawableModels?.High?.Length > 0);
            if (child == null) continue;
            var tris = new List<(ShaderFX, Tri)>();
            foreach (var model in child.Drawable1.DrawableModels.High)
                foreach (var g in model.Geometries ?? [])
                    foreach (var tri in Tri.Read(g, Matrix.Identity, false)) tris.Add((g.Shader, tri));
            // Wheel size from its extent across the hub (game Y/X) and along the axle (game Z)
            var all = tris.SelectMany(t => new[] { t.Item2.A.P, t.Item2.B.P, t.Item2.C.P }).ToList();
            float radius = Math.Max(all.Max(p => p.Y) - all.Min(p => p.Y), all.Max(p => p.X) - all.Min(p => p.X)) / 2;
            float width = all.Max(p => p.Z) - all.Min(p => p.Z);
            wheelMeshes[front] = (gltf.AddMesh(front ? "wheel_front" : "wheel_rear", tris), radius, width);
        }
        var wheelInfo = new JsonArray();
        foreach (var (name, tag, front, right) in Wheels)
        {
            var bi = Array.FindIndex(bones, b => b.Tag == tag);
            if (bi < 0 || !wheelMeshes.TryGetValue(front, out var wm)) continue;
            var pos = Axis.ToGame(boneMatrices[bi].TranslationVector);
            var node = gltf.AddNode(name, wm.mesh, pos, right ? new Quaternion(1, 0, 0, 0) : Quaternion.Identity);
            gltf.AddChild(root, node);
            wheelInfo.Add(new JsonObject
            {
                ["name"] = name,
                ["position"] = new JsonArray(pos.X, pos.Y, pos.Z),
                ["radius"] = wm.radius,
                ["width"] = wm.width,
            });
        }

        var pivots = new JsonObject();
        for (int i = 0; i < bones.Length && i < boneMatrices.Length; i++)
        {
            var p = Axis.ToGame(boneMatrices[i].TranslationVector);
            pivots[bones[i].Name] = new JsonArray(p.X, p.Y, p.Z);
        }
        gltf.SetExtras(root, new JsonObject { ["wheels"] = wheelInfo, ["pivots"] = pivots, ["source"] = Path.GetFileName(yftPath) });
        gltf.Save(outPath);
        Console.WriteLine($"{outPath}: {gltf.Stats} missing textures: {string.Join(", ", gltf.MissingTextures.Order())}");
    }

    /// <summary>
    /// Absolute bone matrices from the skeleton hierarchy (bone transforms are parent-relative).
    /// The fragment's stored pose isn't used: in many mods it's all identity.
    /// </summary>
    static Matrix[] BoneMatrices(FragType frag, Bone[] bones)
    {
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
}

struct Vert
{
    public Vector3 P; // game frame
    public Vector3 N;
    public Vector2 UV;
}

struct Tri
{
    public Vert A, B, C;
    public int Bone; // dominant skin bone of the first vertex, or -1

    /// <summary>Triangles of one geometry, transformed and converted to the game frame.</summary>
    public static IEnumerable<Tri> Read(DrawableGeometry g, Matrix m, bool skinned)
    {
        var vd = g.VertexData;
        var idx = g.IndexBuffer?.Indices;
        if (vd?.Info == null || idx == null) yield break;
        var info = vd.Info;
        bool has(int c) => ((info.Flags >> c) & 1) != 0;
        var verts = new Vert[vd.VertexCount];
        var bone = new int[vd.VertexCount];
        for (int v = 0; v < vd.VertexCount; v++)
        {
            var p = Vector3.TransformCoordinate(vd.GetVector3(v, 0), m);
            var n = Vector3.UnitZ;
            if (has(3))
            {
                n = info.GetComponentType(3) switch
                {
                    VertexComponentType.Float3 => vd.GetVector3(v, 3),
                    VertexComponentType.RGBA8SNorm => (Vector3)vd.GetRGBA8SNorm(v, 3),
                    _ => Vector3.UnitZ,
                };
                var tn = Vector3.TransformNormal(n, m);
                n = tn.LengthSquared() > 1e-12 && !float.IsNaN(tn.X) ? Vector3.Normalize(tn) : Vector3.UnitZ;
            }
            var uv = Vector2.Zero;
            if (has(6))
            {
                uv = info.GetComponentType(6) switch
                {
                    VertexComponentType.Float2 => vd.GetVector2(v, 6),
                    VertexComponentType.Half2 => new Vector2(vd.GetHalf2(v, 6).X, vd.GetHalf2(v, 6).Y),
                    _ => Vector2.Zero,
                };
            }
            verts[v] = new Vert { P = Axis.ToGame(p), N = Axis.ToGame(n), UV = uv };
            bone[v] = -1;
            if (skinned && has(1) && has(2))
            {
                var w = vd.GetColour(v, 1);
                var bi = vd.GetColour(v, 2);
                byte[] ws = [w.R, w.G, w.B, w.A];
                byte[] bs = [bi.R, bi.G, bi.B, bi.A];
                int best = 0;
                for (int k = 1; k < 4; k++) if (ws[k] > ws[best]) best = k;
                int local = bs[best];
                bone[v] = g.BoneIds != null && local < g.BoneIds.Length ? g.BoneIds[local] : local;
            }
        }
        for (int i = 0; i + 2 < idx.Length && i + 2 < g.IndicesCount; i += 3)
        {
            yield return new Tri { A = verts[idx[i]], B = verts[idx[i + 1]], C = verts[idx[i + 2]], Bone = bone[idx[i]] };
        }
    }
}

/// <summary>Minimal glTF 2.0 binary writer: meshes, PBR materials, PNG textures, node tree.</summary>
class Gltf
{
    readonly JsonArray nodes = [], meshes = [], materials = [], textures = [], images = [], accessors = [], bufferViews = [];
    readonly JsonArray sceneNodes = [];
    readonly MemoryStream bin = new();
    readonly Dictionary<string, Texture> texLookup;
    readonly Dictionary<string, int> textureIndex = new(StringComparer.OrdinalIgnoreCase);
    readonly Dictionary<int, float[]> textureAverage = [];
    readonly Dictionary<ShaderFX, int> materialIndex = [];
    readonly int maxTex;
    public readonly HashSet<string> MissingTextures = new(StringComparer.OrdinalIgnoreCase);
    long triangles;

    public Gltf(Dictionary<string, Texture> texLookup, int maxTex)
    {
        this.texLookup = texLookup;
        this.maxTex = maxTex;
    }

    public string Stats => $"{meshes.Count} meshes, {triangles} triangles, {materials.Count} materials, {images.Count} textures, {bin.Length / 1048576.0:F1} MB";

    public int AddNode(string name, int mesh = -1, Vector3? t = null, Quaternion? r = null)
    {
        var n = new JsonObject { ["name"] = name };
        if (mesh >= 0) n["mesh"] = mesh;
        if (t is Vector3 tv) n["translation"] = new JsonArray(tv.X, tv.Y, tv.Z);
        if (r is Quaternion q && !q.IsIdentity) n["rotation"] = new JsonArray(q.X, q.Y, q.Z, q.W);
        nodes.Add(n);
        if (nodes.Count == 1) sceneNodes.Add(0);
        return nodes.Count - 1;
    }

    public void AddChild(int parent, int child)
    {
        var n = nodes[parent]!.AsObject();
        if (n["children"] is not JsonArray c) n["children"] = c = [];
        c.Add(child);
    }

    public void SetExtras(int node, JsonObject extras) => nodes[node]!.AsObject()["extras"] = extras;

    public int AddMesh(string name, IEnumerable<(ShaderFX shader, Tri tri)> tris)
    {
        var prims = new JsonArray();
        foreach (var group in tris.GroupBy(t => t.shader))
        {
            var list = group.Select(t => t.tri).ToList();
            triangles += list.Count;
            // Unindexed triangle soup, then welded by gltf-transform downstream
            var pos = new float[list.Count * 9];
            var nrm = new float[list.Count * 9];
            var uv = new float[list.Count * 6];
            int pi = 0, ui = 0;
            foreach (var t in list)
            {
                foreach (var v in new[] { t.A, t.B, t.C })
                {
                    pos[pi] = v.P.X; pos[pi + 1] = v.P.Y; pos[pi + 2] = v.P.Z;
                    nrm[pi] = v.N.X; nrm[pi + 1] = v.N.Y; nrm[pi + 2] = v.N.Z;
                    pi += 3;
                    uv[ui] = v.UV.X; uv[ui + 1] = v.UV.Y;
                    ui += 2;
                }
            }
            var attrs = new JsonObject
            {
                ["POSITION"] = Accessor(pos, 3, true),
                ["NORMAL"] = Accessor(nrm, 3, false),
                ["TEXCOORD_0"] = Accessor(uv, 2, false),
            };
            prims.Add(new JsonObject { ["attributes"] = attrs, ["material"] = Material(group.Key) });
        }
        meshes.Add(new JsonObject { ["name"] = name, ["primitives"] = prims });
        return meshes.Count - 1;
    }

    int Accessor(float[] data, int comps, bool minMax)
    {
        var view = View(MemoryMarshalBytes(data), 34962);
        var a = new JsonObject
        {
            ["bufferView"] = view, ["componentType"] = 5126, ["count"] = data.Length / comps,
            ["type"] = comps == 3 ? "VEC3" : "VEC2",
        };
        if (minMax)
        {
            var min = new JsonArray(); var max = new JsonArray();
            for (int c = 0; c < comps; c++)
            {
                float lo = float.MaxValue, hi = float.MinValue;
                for (int i = c; i < data.Length; i += comps) { lo = Math.Min(lo, data[i]); hi = Math.Max(hi, data[i]); }
                min.Add(lo); max.Add(hi);
            }
            a["min"] = min; a["max"] = max;
        }
        accessors.Add(a);
        return accessors.Count - 1;
    }

    static byte[] MemoryMarshalBytes(float[] data)
    {
        var b = new byte[data.Length * 4];
        Buffer.BlockCopy(data, 0, b, 0, b.Length);
        return b;
    }

    int View(byte[] bytes, int target = 0)
    {
        while (bin.Length % 4 != 0) bin.WriteByte(0);
        var offset = bin.Length;
        bin.Write(bytes);
        var v = new JsonObject { ["buffer"] = 0, ["byteOffset"] = offset, ["byteLength"] = bytes.Length };
        if (target != 0) v["target"] = target;
        bufferViews.Add(v);
        return bufferViews.Count - 1;
    }

    static readonly string[] Blended = ["glass", "decal", "badges", "alpha", "cutout", "_dirt"];

    int Material(ShaderFX s)
    {
        if (s != null && materialIndex.TryGetValue(s, out var existing)) return existing;
        var shader = ShaderNames.Of(s);
        var tex = new Dictionary<string, string>();
        var vec = new Dictionary<string, Vector4>();
        var pl = s?.ParametersList;
        for (int i = 0; i < (pl?.Parameters?.Length ?? 0); i++)
        {
            var p = pl.Parameters[i];
            var name = pl.Hashes[i].ToString().ToLowerInvariant();
            if (p.DataType == 0 && p.Data is TextureBase tb && !string.IsNullOrEmpty(tb.Name)) tex[name] = tb.Name;
            else if (p.DataType == 1 && p.Data is Vector4 v4) vec[name] = v4;
        }

        var pbr = new JsonObject { ["metallicFactor"] = 0.0 };
        var m = new JsonObject { ["name"] = shader, ["pbrMetallicRoughness"] = pbr };
        var extras = new JsonObject { ["shader"] = shader };
        tex.TryGetValue("diffusesampler", out var diffuseName);
        if (diffuseName != null) extras["diffuse"] = diffuseName;
        var diffuse = diffuseName == null ? -1 : TextureFor(diffuseName, false);
        if (diffuse >= 0)
        {
            pbr["baseColorTexture"] = new JsonObject { ["index"] = diffuse };
            // Average color lets the game tell tinted parts (GTA tints e.g. rims with a paint color) from dark ones
            var avg = textureAverage[diffuse];
            extras["average"] = new JsonArray(avg[0], avg[1], avg[2]);
        }
        else
        {
            // Game-shared textures (vehicle_generic_*) aren't in mods; pick a plausible flat color
            float g = diffuseName != null && diffuseName.Contains("black") ? 0.03f : 0.5f;
            pbr["baseColorFactor"] = new JsonArray(g, g, g, 1.0);
        }
        if (tex.TryGetValue("bumpsampler", out var bump) && !bump.Contains("blank"))
        {
            var n = TextureFor(bump, true);
            if (n >= 0) m["normalTexture"] = new JsonObject { ["index"] = n };
        }

        // GTA specular falloff ~ glossiness
        float falloff = vec.TryGetValue("specularfalloffmult", out var f) ? f.X : 40;
        pbr["roughnessFactor"] = falloff >= 100 ? 0.25 : falloff >= 30 ? 0.45 : 0.7;

        if (shader.StartsWith("vehicle_paint"))
        {
            var digits = new string(shader.Skip("vehicle_paint".Length).TakeWhile(char.IsDigit).ToArray());
            extras["paint"] = digits.Length > 0 ? int.Parse(digits) : 1;
        }
        if (shader.Contains("emissive") || shader.Contains("lights"))
        {
            extras["emissive"] = true;
            if (diffuse >= 0) m["emissiveTexture"] = new JsonObject { ["index"] = diffuse };
            m["emissiveFactor"] = new JsonArray(1.0, 1.0, 1.0);
        }
        if (shader.Contains("tire") || shader.Contains("tyre")) pbr["roughnessFactor"] = 0.9;
        if (Blended.Any(b => shader.Contains(b)))
        {
            m["alphaMode"] = "BLEND";
            if (shader.Contains("glass")) { extras["glass"] = true; pbr["roughnessFactor"] = 0.05; }
        }
        m["doubleSided"] = shader.Contains("glass") || shader.Contains("decal");
        m["extras"] = extras;
        materials.Add(m);
        var idx = materials.Count - 1;
        if (s != null) materialIndex[s] = idx;
        return idx;
    }

    int TextureFor(string name, bool normalMap)
    {
        var key = (normalMap ? "n:" : "c:") + name;
        if (textureIndex.TryGetValue(key, out var existing)) return existing;
        if (!texLookup.TryGetValue(name, out var t)) { MissingTextures.Add(name); textureIndex[key] = -1; return -1; }
        int mip = 0;
        while (mip < t.Levels - 1 && Math.Max(t.Width, t.Height) >> mip > maxTex) mip++;
        byte[] px;
        try { px = DDSIO.GetPixels(t, mip); }
        catch { px = null; }
        if (px == null) { MissingTextures.Add(name + $"({t.Format})"); textureIndex[key] = -1; return -1; }
        int w = Math.Max(1, t.Width >> mip), h = Math.Max(1, t.Height >> mip);
        if (normalMap)
        {
            // Rebuild Z from XY (BC5 stores two channels) and flip green from DirectX to glTF's convention
            for (int i = 0; i < px.Length; i += 4)
            {
                float x = px[i] / 127.5f - 1, y = px[i + 1] / 127.5f - 1;
                float z = MathF.Sqrt(MathF.Max(0, 1 - x * x - y * y));
                px[i + 1] = (byte)(255 - px[i + 1]);
                px[i + 2] = (byte)Math.Clamp(z * 127.5f + 127.5f, 0, 255);
                px[i + 3] = 255;
            }
        }
        double sr = 0, sg = 0, sb = 0;
        for (int i = 0; i < px.Length; i += 4) { sr += px[i]; sg += px[i + 1]; sb += px[i + 2]; }
        var count = Math.Max(1, px.Length / 4) * 255.0;
        var png = Png.Encode(px, w, h);
        images.Add(new JsonObject { ["name"] = name, ["mimeType"] = "image/png", ["bufferView"] = View(png) });
        textures.Add(new JsonObject { ["source"] = images.Count - 1, ["sampler"] = 0 });
        textureAverage[textures.Count - 1] = [(float)(sr / count), (float)(sg / count), (float)(sb / count)];
        return textureIndex[key] = textures.Count - 1;
    }

    public void Save(string path)
    {
        var json = new JsonObject
        {
            ["asset"] = new JsonObject { ["version"] = "2.0", ["generator"] = "open-horizon gta5conv" },
            ["scene"] = 0,
            ["scenes"] = new JsonArray(new JsonObject { ["nodes"] = sceneNodes }),
            ["nodes"] = nodes, ["meshes"] = meshes, ["materials"] = materials, ["accessors"] = accessors,
            ["bufferViews"] = bufferViews, ["buffers"] = new JsonArray(new JsonObject { ["byteLength"] = bin.Length }),
        };
        if (images.Count > 0)
        {
            json["images"] = images;
            json["textures"] = textures;
            json["samplers"] = new JsonArray(new JsonObject { ["magFilter"] = 9729, ["minFilter"] = 9987, ["wrapS"] = 10497, ["wrapT"] = 10497 });
        }
        var jsonBytes = System.Text.Encoding.UTF8.GetBytes(json.ToJsonString());
        int jsonPad = (4 - jsonBytes.Length % 4) % 4;
        while (bin.Length % 4 != 0) bin.WriteByte(0);
        using var fs = File.Create(path);
        using var w = new BinaryWriter(fs);
        w.Write(0x46546C67u); w.Write(2u);
        w.Write((uint)(12 + 8 + jsonBytes.Length + jsonPad + 8 + bin.Length));
        w.Write((uint)(jsonBytes.Length + jsonPad)); w.Write(0x4E4F534Au);
        w.Write(jsonBytes); for (int i = 0; i < jsonPad; i++) w.Write((byte)0x20);
        w.Write((uint)bin.Length); w.Write(0x004E4942u);
        w.Write(bin.ToArray());
    }
}

static class Png
{
    static readonly uint[] Crc = Enumerable.Range(0, 256).Select(n =>
    {
        uint c = (uint)n;
        for (int k = 0; k < 8; k++) c = (c & 1) != 0 ? 0xEDB88320 ^ (c >> 1) : c >> 1;
        return c;
    }).ToArray();

    public static byte[] Encode(byte[] rgba, int w, int h)
    {
        using var raw = new MemoryStream();
        using (var z = new ZLibStream(raw, CompressionLevel.Fastest, true))
        {
            var row = new byte[w * 4 + 1];
            for (int y = 0; y < h; y++)
            {
                row[0] = 0;
                Buffer.BlockCopy(rgba, y * w * 4, row, 1, w * 4);
                z.Write(row);
            }
        }
        using var png = new MemoryStream();
        png.Write([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
        var ihdr = new byte[13];
        WriteBE(ihdr, 0, (uint)w); WriteBE(ihdr, 4, (uint)h);
        ihdr[8] = 8; ihdr[9] = 6;
        Chunk(png, "IHDR", ihdr);
        Chunk(png, "IDAT", raw.ToArray());
        Chunk(png, "IEND", []);
        return png.ToArray();
    }

    static void Chunk(Stream s, string type, byte[] data)
    {
        var len = new byte[4]; WriteBE(len, 0, (uint)data.Length); s.Write(len);
        var td = System.Text.Encoding.ASCII.GetBytes(type).Concat(data).ToArray();
        s.Write(td);
        uint c = 0xFFFFFFFF;
        foreach (var b in td) c = Crc[(c ^ b) & 0xFF] ^ (c >> 8);
        var crc = new byte[4]; WriteBE(crc, 0, c ^ 0xFFFFFFFF); s.Write(crc);
    }

    static void WriteBE(byte[] b, int o, uint v)
    {
        b[o] = (byte)(v >> 24); b[o + 1] = (byte)(v >> 16); b[o + 2] = (byte)(v >> 8); b[o + 3] = (byte)v;
    }
}
