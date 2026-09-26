// Texture listing and export: find textures by name across a mod (texture dictionaries and textures
// embedded in drawables) and write them as PNG.
//   gta5conv tex <dir> [--grep <regex>]                       list name, size, format, source file
//   gta5conv tex <dir> --grep <regex> --out <dir> [--max 1024] [--derive-normal]
//                                                  also export the matches as <name>.png
// Normal maps (names ending in _n / _nrm / normal) get Z rebuilt from XY when the format stores two
// channels, and green flipped from GTA's DirectX convention to OpenGL's (three.js, glTF).
// --derive-normal also writes <name>_n.png for colour textures: a tiling normal map from luminance
// as height (for surfaces like water that ship without one).
using System.Text.RegularExpressions;
using CodeWalker.GameFiles;
using CodeWalker.Utils;

static class TexExport
{
    public static void Run(string[] args)
    {
        string dir = args[0], grep = null, outDir = null;
        int max = 1024;
        bool derive = false;
        for (int i = 1; i < args.Length; i++)
        {
            if (args[i] == "--derive-normal") derive = true;
            if (args[i] == "--grep") grep = args[++i];
            else if (args[i] == "--out") outDir = args[++i];
            else if (args[i] == "--max") max = int.Parse(args[++i]);
        }
        var re = grep != null ? new Regex(grep, RegexOptions.IgnoreCase) : null;
        if (outDir != null) Directory.CreateDirectory(outDir);
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var path in Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories).Order())
        {
            var ext = Path.GetExtension(path).ToLowerInvariant();
            IEnumerable<Texture> textures;
            try
            {
                textures = ext switch
                {
                    ".ytd" => new YtdFile().With(f => f.Load(File.ReadAllBytes(path))).TextureDict?.Textures?.data_items,
                    ".ydr" => new YdrFile().With(f => f.Load(File.ReadAllBytes(path))).Drawable?.ShaderGroup?.TextureDictionary?.Textures?.data_items,
                    ".yft" => new YftFile().With(f => f.Load(File.ReadAllBytes(path))).Fragment?.Drawable?.ShaderGroup?.TextureDictionary?.Textures?.data_items,
                    ".ydd" => new YddFile().With(f => f.Load(File.ReadAllBytes(path))).Drawables?.SelectMany(d => d?.ShaderGroup?.TextureDictionary?.Textures?.data_items ?? []),
                    _ => null,
                };
            }
            catch (Exception ex) { Console.Error.WriteLine($"skipping {path}: {ex.GetType().Name}"); continue; }
            foreach (var t in textures ?? [])
            {
                if (t?.Name == null || (re != null && !re.IsMatch(t.Name)) || !seen.Add(t.Name)) continue;
                Console.WriteLine($"{t.Name,-40} {t.Width}x{t.Height} {t.Format} L{t.Levels}  {Path.GetRelativePath(dir, path)}");
                if (outDir != null) Export(t, Path.Combine(outDir, t.Name.ToLowerInvariant() + ".png"), max, derive);
            }
        }
    }

    static T With<T>(this T f, Action<T> load) { load(f); return f; }

    public static bool Export(Texture t, string path, int max, bool derive = false)
    {
        int mip = 0;
        while (mip < t.Levels - 1 && Math.Max(t.Width, t.Height) >> mip > max) mip++;
        byte[] px;
        try { px = DDSIO.GetPixels(t, mip); } catch { px = null; }
        if (px == null) { Console.Error.WriteLine($"  can't decode {t.Name} ({t.Format})"); return false; }
        int w = Math.Max(1, t.Width >> mip), h = Math.Max(1, t.Height >> mip);
        for (int i = 0; i < px.Length; i += 4) (px[i], px[i + 2]) = (px[i + 2], px[i]); // CodeWalker decodes to BGRA
        var n = t.Name.ToLowerInvariant();
        bool normal = n.EndsWith("_n") || n.EndsWith("_nrm") || n.Contains("normal") || n.EndsWith("_nm");
        if (normal)
        {
            // Two-channel formats (BC5, DXT5 with XY in alpha/green) leave blue empty: rebuild Z
            bool flat = true;
            for (int i = 0; i < px.Length && flat; i += 4 * 97) flat = px[i + 2] < 8;
            bool dxt5nm = t.Format == TextureFormat.D3DFMT_DXT5 && flat;
            for (int i = 0; i < px.Length && (flat || dxt5nm); i += 4)
            {
                if (dxt5nm) px[i] = px[i + 3];
                float x = px[i] / 127.5f - 1, y = px[i + 1] / 127.5f - 1;
                px[i + 2] = (byte)Math.Clamp(MathF.Sqrt(MathF.Max(0, 1 - x * x - y * y)) * 127.5f + 127.5f, 0, 255);
                px[i + 3] = 255;
            }
            for (int i = 0; i < px.Length; i += 4) px[i + 1] = (byte)(255 - px[i + 1]);
        }
        File.WriteAllBytes(path, Png.Encode(px, w, h));
        Console.WriteLine($"  → {path} ({w}x{h}{(normal ? ", normal map" : "")})");
        if (derive && !normal)
        {
            var np = NormalFromHeight(px, w, h, 3f);
            var npath = Path.Combine(Path.GetDirectoryName(path)!, Path.GetFileNameWithoutExtension(path) + "_n.png");
            File.WriteAllBytes(npath, Png.Encode(np, w, h));
            Console.WriteLine($"  → {npath} ({w}x{h}, normal map derived from luminance)");
        }
        return true;
    }

    /// <summary>Tiling OpenGL-style normal map from an RGBA image's luminance as height (Sobel, wrapping at the edges).</summary>
    static byte[] NormalFromHeight(byte[] rgba, int w, int h, float strength)
    {
        var height = new float[w * h];
        for (int i = 0; i < w * h; i++) height[i] = (0.299f * rgba[i * 4] + 0.587f * rgba[i * 4 + 1] + 0.114f * rgba[i * 4 + 2]) / 255f;
        float at(int x, int y) => height[((y % h + h) % h) * w + (x % w + w) % w];
        var o = new byte[w * h * 4];
        for (int y = 0; y < h; y++)
            for (int x = 0; x < w; x++)
            {
                float dx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
                float dy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
                // Image rows run down, OpenGL tangent-space Y runs up
                float nx = -dx * strength, ny = dy * strength, nz = 1;
                float len = MathF.Sqrt(nx * nx + ny * ny + nz * nz);
                int k = (y * w + x) * 4;
                o[k] = (byte)Math.Clamp((nx / len) * 127.5f + 127.5f, 0, 255);
                o[k + 1] = (byte)Math.Clamp((ny / len) * 127.5f + 127.5f, 0, 255);
                o[k + 2] = (byte)Math.Clamp((nz / len) * 127.5f + 127.5f, 0, 255);
                o[k + 3] = 255;
            }
        return o;
    }
}
