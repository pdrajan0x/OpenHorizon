// Texture output for the game's .gtx: "GTX1", u32 format (1/5 = DXT1/DXT5, 0 = RGBA8), u16 w, u16 h, u16 mips,
// u16 pad, then the mip chain, largest first (the same format tools/gta5conv writes). DXT textures are
// copied as they are; anything else is decoded to RGBA and compressed here (BC1, or BC3 where there's alpha).
static class Bc
{
    public static void WriteGtx(string file, int format, List<(int w, int h, byte[] data)> levels)
    {
        using var fs = File.Create(file);
        using var w = new BinaryWriter(fs);
        w.Write("GTX1"u8.ToArray());
        w.Write((uint)format);
        w.Write((ushort)levels[0].w);
        w.Write((ushort)levels[0].h);
        w.Write((ushort)levels.Count);
        w.Write((ushort)0);
        foreach (var l in levels) w.Write(l.data);
    }

    /** A mip chain (2×2 box filter) of an RGBA image down to 4×4, compressed. */
    public static List<(int w, int h, byte[] data)> Chain(byte[] rgba, int w, int h, bool alpha)
    {
        var levels = new List<(int, int, byte[])>();
        while (true)
        {
            levels.Add((w, h, Encode(rgba, w, h, alpha)));
            if (w <= 4 && h <= 4) break;
            int nw = Math.Max(1, w >> 1), nh = Math.Max(1, h >> 1);
            var next = new byte[nw * nh * 4];
            for (int y = 0; y < nh; y++)
                for (int x = 0; x < nw; x++)
                    for (int k = 0; k < 4; k++)
                    {
                        int at(int xx, int yy) => rgba[(Math.Min(h - 1, yy) * w + Math.Min(w - 1, xx)) * 4 + k];
                        next[(y * nw + x) * 4 + k] = (byte)((at(2 * x, 2 * y) + at(2 * x + 1, 2 * y) + at(2 * x, 2 * y + 1) + at(2 * x + 1, 2 * y + 1) + 2) >> 2);
                    }
            rgba = next; w = nw; h = nh;
        }
        return levels;
    }

    static int To565(double r, double g, double b) =>
        ((int)Math.Round(r * 31 / 255) << 11) | ((int)Math.Round(g * 63 / 255) << 5) | (int)Math.Round(b * 31 / 255);
    static double[] From565(int c) => [((c >> 11) & 31) * 255.0 / 31, ((c >> 5) & 63) * 255.0 / 63, (c & 31) * 255.0 / 31];

    /** BC1 (or BC3 with alpha): endpoints are each block's extremes by luminance, inset a little. */
    public static byte[] Encode(byte[] px, int w, int h, bool alpha)
    {
        int bw = Math.Max(1, (w + 3) / 4), bh = Math.Max(1, (h + 3) / 4), block = alpha ? 16 : 8;
        var output = new byte[bw * bh * block];
        var pix = new byte[16][];
        for (int by = 0; by < bh; by++)
            for (int bx = 0; bx < bw; bx++)
            {
                for (int i = 0; i < 16; i++)
                {
                    int x = Math.Min(w - 1, bx * 4 + (i & 3)), y = Math.Min(h - 1, by * 4 + (i >> 2)), q = (y * w + x) * 4;
                    pix[i] = [px[q], px[q + 1], px[q + 2], px[q + 3]];
                }
                int o = (by * bw + bx) * block;
                if (alpha)
                {
                    byte a0 = 0, a1 = 255;
                    foreach (var p in pix) { a0 = Math.Max(a0, p[3]); a1 = Math.Min(a1, p[3]); }
                    output[o] = a0; output[o + 1] = a1;
                    var pal = new double[8];
                    pal[0] = a0; pal[1] = a1;
                    for (int i = 1; i < 7; i++) pal[i + 1] = ((7 - i) * a0 + i * (double)a1) / 7;
                    ulong bits = 0;
                    for (int i = 0; i < 16; i++)
                    {
                        int best = 0;
                        for (int k = 1; k < 8; k++) if (Math.Abs(pal[k] - pix[i][3]) < Math.Abs(pal[best] - pix[i][3])) best = k;
                        if (a0 == a1) best = 0;
                        bits |= (ulong)best << (3 * i);
                    }
                    for (int i = 0; i < 6; i++) output[o + 2 + i] = (byte)(bits >> (8 * i));
                    o += 8;
                }
                double Lum(byte[] p) => p[0] * 0.3 + p[1] * 0.59 + p[2] * 0.11;
                byte[] lo = pix[0], hi = pix[0];
                foreach (var p in pix) { if (Lum(p) < Lum(lo)) lo = p; if (Lum(p) > Lum(hi)) hi = p; }
                int e0 = To565(hi[0] + (lo[0] - hi[0]) / 16.0, hi[1] + (lo[1] - hi[1]) / 16.0, hi[2] + (lo[2] - hi[2]) / 16.0);
                int e1 = To565(lo[0] + (hi[0] - lo[0]) / 16.0, lo[1] + (hi[1] - lo[1]) / 16.0, lo[2] + (hi[2] - lo[2]) / 16.0);
                if (e0 < e1) (e0, e1) = (e1, e0);
                var p0 = From565(e0); var p1 = From565(e1);
                double[][] palette = [p0, p1, [(2 * p0[0] + p1[0]) / 3, (2 * p0[1] + p1[1]) / 3, (2 * p0[2] + p1[2]) / 3], [(p0[0] + 2 * p1[0]) / 3, (p0[1] + 2 * p1[1]) / 3, (p0[2] + 2 * p1[2]) / 3]];
                uint idx = 0;
                if (e0 != e1)
                    for (int i = 0; i < 16; i++)
                    {
                        int best = 0; double bd = double.MaxValue;
                        for (int k = 0; k < 4; k++)
                        {
                            double d = Math.Pow(palette[k][0] - pix[i][0], 2) + Math.Pow(palette[k][1] - pix[i][1], 2) + Math.Pow(palette[k][2] - pix[i][2], 2);
                            if (d < bd) { bd = d; best = k; }
                        }
                        idx |= (uint)best << (2 * i);
                    }
                output[o] = (byte)e0; output[o + 1] = (byte)(e0 >> 8); output[o + 2] = (byte)e1; output[o + 3] = (byte)(e1 >> 8);
                output[o + 4] = (byte)idx; output[o + 5] = (byte)(idx >> 8); output[o + 6] = (byte)(idx >> 16); output[o + 7] = (byte)(idx >> 24);
            }
        return output;
    }
}
