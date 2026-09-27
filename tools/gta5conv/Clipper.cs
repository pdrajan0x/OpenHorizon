// A new coastline for a map (--clip): what lies inside a set of loops (game frame x, z; even-odd) stays.
// Meshes are split into their connected pieces first: a piece smaller than PieceMax (a building merged
// into a big mesh) is kept or left out whole by where its middle stands, so no building is sliced open.
// Bigger pieces (ground, terrain, long roads) are cut along the shore: triangles that cross it are
// split into smaller ones (attributes interpolated) until what's left is inside or tiny.
using SharpDX;

sealed class Clipper
{
    const float Cell = 4; // m per raster cell of the inside test
    const float PieceMax = 80; // m across: a piece this small stays or goes whole
    const float MinEdge = 3; // m: triangles across the shore are split down to this size
    const int MaxDepth = 12;

    readonly List<Vector2[]> loops;
    readonly float x0, z0;
    readonly int nx, nz;
    readonly int[] sat; // summed-area table of inside cells, (nx + 1) × (nz + 1)

    public Clipper(List<Vector2[]> loops)
    {
        this.loops = loops;
        float minX = float.MaxValue, minZ = float.MaxValue, maxX = float.MinValue, maxZ = float.MinValue;
        foreach (var l in loops) foreach (var p in l) { minX = Math.Min(minX, p.X); maxX = Math.Max(maxX, p.X); minZ = Math.Min(minZ, p.Y); maxZ = Math.Max(maxZ, p.Y); }
        x0 = MathF.Floor(minX / Cell) * Cell - Cell * 2;
        z0 = MathF.Floor(minZ / Cell) * Cell - Cell * 2;
        nx = (int)MathF.Ceiling((maxX - x0) / Cell) + 4;
        nz = (int)MathF.Ceiling((maxZ - z0) / Cell) + 4;
        var inside = new bool[nx * nz];
        var zs = new List<float>();
        for (int i = 0; i < nx; i++)
        {
            float x = x0 + (i + 0.5f) * Cell;
            zs.Clear();
            foreach (var l in loops)
                for (int a = 0, b = l.Length - 1; a < l.Length; b = a++)
                    if ((l[a].X <= x) != (l[b].X <= x)) zs.Add(l[a].Y + (x - l[a].X) / (l[b].X - l[a].X) * (l[b].Y - l[a].Y));
            zs.Sort();
            for (int k = 0; k + 1 < zs.Count; k += 2)
                for (int j = Math.Max(0, (int)MathF.Ceiling((zs[k] - z0) / Cell - 0.5f)); j < nz && z0 + (j + 0.5f) * Cell <= zs[k + 1]; j++)
                    inside[i * nz + j] = true;
        }
        sat = new int[(nx + 1) * (nz + 1)];
        for (int i = 0; i < nx; i++)
            for (int j = 0; j < nz; j++)
                sat[(i + 1) * (nz + 1) + j + 1] = (inside[i * nz + j] ? 1 : 0) + sat[i * (nz + 1) + j + 1] + sat[(i + 1) * (nz + 1) + j] - sat[i * (nz + 1) + j];
    }

    /** Exactly inside the loops (even-odd). */
    public bool Inside(float x, float z)
    {
        bool odd = false;
        foreach (var l in loops)
            for (int a = 0, b = l.Length - 1; a < l.Length; b = a++)
                if ((l[a].Y > z) != (l[b].Y > z) && x < (l[b].X - l[a].X) * (z - l[a].Y) / (l[b].Y - l[a].Y) + l[a].X) odd = !odd;
        return odd;
    }

    /** Inside by the raster (to Cell m): fast, for testing many points. */
    public bool InsideFast(float x, float z)
    {
        int i = (int)MathF.Floor((x - x0) / Cell), j = (int)MathF.Floor((z - z0) / Cell);
        if (i < 0 || j < 0 || i >= nx || j >= nz) return false;
        return sat[(i + 1) * (nz + 1) + j + 1] - sat[i * (nz + 1) + j + 1] - sat[(i + 1) * (nz + 1) + j] + sat[i * (nz + 1) + j] > 0;
    }

    /** +1 when a triangle's footprint is all inside, −1 all outside, 0 when it may cross the shore. */
    int Classify(Vector3 a, Vector3 b, Vector3 c)
    {
        int i0 = (int)MathF.Floor((Math.Min(a.X, Math.Min(b.X, c.X)) - x0) / Cell), i1 = (int)MathF.Floor((Math.Max(a.X, Math.Max(b.X, c.X)) - x0) / Cell);
        int j0 = (int)MathF.Floor((Math.Min(a.Z, Math.Min(b.Z, c.Z)) - z0) / Cell), j1 = (int)MathF.Floor((Math.Max(a.Z, Math.Max(b.Z, c.Z)) - z0) / Cell);
        long total = (long)(i1 - i0 + 1) * (j1 - j0 + 1);
        int ci0 = Math.Max(0, i0), ci1 = Math.Min(nx - 1, i1), cj0 = Math.Max(0, j0), cj1 = Math.Min(nz - 1, j1);
        if (ci0 > ci1 || cj0 > cj1) return -1; // off the raster: outside
        int n = sat[(ci1 + 1) * (nz + 1) + cj1 + 1] - sat[ci0 * (nz + 1) + cj1 + 1] - sat[(ci1 + 1) * (nz + 1) + cj0] + sat[ci0 * (nz + 1) + cj0];
        return n == 0 ? -1 : n == total ? 1 : 0;
    }

    /**
     * The triangles (indices into pos, three per triangle) that stay, with the new vertices of any split
     * appended to the attribute lists (nrm, uv, col may be null). `source` gives, per triangle out, the
     * triangle in that it came from.
     */
    public (List<int> tri, List<int> source) Trim(List<Vector3> pos, List<Vector3> nrm, List<Vector2> uv, List<uint> col, IReadOnlyList<int> tri)
    {
        int n = pos.Count;
        var parent = new int[n];
        for (int i = 0; i < n; i++) parent[i] = i;
        int find(int i) { while (parent[i] != i) i = parent[i] = parent[parent[i]]; return i; }
        for (int t = 0; t + 2 < tri.Count; t += 3)
        {
            int a = find(tri[t]), b = find(tri[t + 1]), c = find(tri[t + 2]);
            if (a != b) parent[a] = b;
            c = find(c); b = find(b);
            if (c != b) parent[c] = b;
        }
        // Each piece's extent and middle
        var lo = new Dictionary<int, Vector3>();
        var hi = new Dictionary<int, Vector3>();
        var keepPiece = new Dictionary<int, bool>();
        foreach (var v in tri.Distinct())
        {
            int r = find(v);
            lo[r] = lo.TryGetValue(r, out var l) ? Vector3.Min(l, pos[v]) : pos[v];
            hi[r] = hi.TryGetValue(r, out var h) ? Vector3.Max(h, pos[v]) : pos[v];
        }
        foreach (var r in lo.Keys)
        {
            var size = hi[r] - lo[r];
            if (Math.Max(size.X, size.Z) < PieceMax) keepPiece[r] = Inside((lo[r].X + hi[r].X) / 2, (lo[r].Z + hi[r].Z) / 2);
        }

        var outTri = new List<int>();
        var source = new List<int>();
        for (int t = 0; t + 2 < tri.Count; t += 3)
        {
            int ia = tri[t], ib = tri[t + 1], ic = tri[t + 2];
            if (keepPiece.TryGetValue(find(ia), out var whole))
            {
                if (whole) { outTri.AddRange([ia, ib, ic]); source.Add(t / 3); }
                continue;
            }
            Split(ia, ib, ic, new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1), MaxDepth, t / 3);
        }
        return (outTri, source);

        // Barycentric corners (wa, wb, wc) of the triangle (ia, ib, ic)
        void Split(int ia, int ib, int ic, Vector3 wa, Vector3 wb, Vector3 wc, int depth, int from)
        {
            Vector3 at(Vector3 w) => pos[ia] * w.X + pos[ib] * w.Y + pos[ic] * w.Z;
            Vector3 pa = at(wa), pb = at(wb), pc = at(wc);
            int cls = Classify(pa, pb, pc);
            if (cls < 0) return;
            float edge = Math.Max(Vector3.Distance(pa, pb), Math.Max(Vector3.Distance(pb, pc), Vector3.Distance(pc, pa)));
            if (cls == 0 && depth > 0 && edge > MinEdge)
            {
                Vector3 ab = (wa + wb) / 2, bc = (wb + wc) / 2, ca = (wc + wa) / 2;
                Split(ia, ib, ic, wa, ab, ca, depth - 1, from);
                Split(ia, ib, ic, ab, wb, bc, depth - 1, from);
                Split(ia, ib, ic, ca, bc, wc, depth - 1, from);
                Split(ia, ib, ic, ab, bc, ca, depth - 1, from);
                return;
            }
            if (cls == 0)
            {
                var m = (pa + pb + pc) / 3;
                if (!Inside(m.X, m.Z)) return;
            }
            // The whole original triangle: its own vertices
            if (wa.X == 1 && wb.Y == 1 && wc.Z == 1) { outTri.AddRange([ia, ib, ic]); source.Add(from); return; }
            outTri.Add(Vertex(wa)); outTri.Add(Vertex(wb)); outTri.Add(Vertex(wc));
            source.Add(from);

            int Vertex(Vector3 w)
            {
                pos.Add(at(w));
                if (nrm != null)
                {
                    var nn = nrm[ia] * w.X + nrm[ib] * w.Y + nrm[ic] * w.Z;
                    nrm.Add(nn.LengthSquared() > 1e-12f ? Vector3.Normalize(nn) : new Vector3(0, 1, 0));
                }
                uv?.Add(uv[ia] * w.X + uv[ib] * w.Y + uv[ic] * w.Z);
                if (col != null)
                {
                    uint c = 0;
                    for (int s = 0; s < 32; s += 8)
                        c |= (uint)Math.Clamp(MathF.Round(((col[ia] >> s) & 255) * w.X + ((col[ib] >> s) & 255) * w.Y + ((col[ic] >> s) & 255) * w.Z), 0, 255) << s;
                    col.Add(c);
                }
                return pos.Count - 1;
            }
        }
    }
}
