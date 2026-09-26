// A road graph for maps that ship no vehicle path nodes (.ynd): derived from the road surface itself.
//
// The surface triangles (collision or render triangles picked by file name, material or texture; see
// MapWriter's --road-col / --road-mat / --road-tex) are rasterized into 1 m pixels. Each pixel column
// can hold several layers (a bridge over a street), and pixels only neighbour pixels at a similar
// height, so levels stay apart. The surface is thinned to its centerlines (Zhang-Suen on the layered
// grid), the centerline pixels are traced into a graph (junctions where three or more meet), and the
// graph is cleaned up: short spurs from ragged edges pruned, loops around traffic islands collapsed,
// junction clusters merged, tiny pieces dropped. Edges are then resampled into nodes every ≤ 25 m.
// Lanes per direction come from the surface width along each edge (roads are taken as two-way).
//
// Positions are in the game frame (x north, y up, z east), like everything MapWriter produces.
using SharpDX;

static class RoadDerive
{
    const float Px = 1f; // pixel size, m
    const float LayerGap = 2.5f; // surfaces closer than this in one column are one layer (road + curb, decals)
    const float MaxStep = 0.55f; // m of height change between neighbouring pixels (≈ 50 % grade)
    const int MinComponentPixels = 400; // m² of surface below which a piece is ignored
    const float SpurLength = 22; // m: dead ends shorter than this off a junction are skeleton noise
    const float JunctionMerge = 16; // m: junctions closer than this become one (the corners of a wide crossing)
    const float MinGraphLength = 300; // m: road networks shorter than this in total are dropped
    const float MaxSegment = 25; // m between output nodes
    const float SimplifyTolerance = 1.0f; // m
    const float LaneWidth = 3.8f; // m of surface per lane (the surface often includes gutters/sidewalks)

    static readonly (int dx, int dz)[] Dirs = [(0, -1), (1, -1), (1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0), (-1, -1)];

    public static (List<Vector3> nodes, List<(int a, int b, int lanesAB, int lanesBA)> links) Build(List<Vector3> tris)
    {
        // --- Rasterize into layered pixels ---
        var pxX = new List<int>(); var pxZ = new List<int>(); var pxH = new List<float>();
        var head = new Dictionary<long, int>(); var next = new List<int>();
        static long Key(int x, int z) => ((long)x << 32) ^ (uint)z;
        void insert(int x, int z, float h)
        {
            var k = Key(x, z);
            if (head.TryGetValue(k, out var i))
            {
                for (; i >= 0; i = next[i])
                    if (Math.Abs(pxH[i] - h) < LayerGap) { if (h > pxH[i]) pxH[i] = h; return; }
                next.Add(head[k]);
            }
            else next.Add(-1);
            head[k] = pxX.Count;
            pxX.Add(x); pxZ.Add(z); pxH.Add(h);
        }
        int used = 0;
        // Only surfaces facing up (not tunnel ceilings); collision winding is consistent within a mod, but
        // which way round varies, so go with the majority
        int up = 0, down = 0;
        for (int t = 0; t + 2 < tris.Count; t += 3)
        {
            var n = Vector3.Cross(tris[t + 1] - tris[t], tris[t + 2] - tris[t]);
            var len = n.Length();
            if (len < 1e-6f) continue;
            if (n.Y / len > 0.7f) up++; else if (n.Y / len < -0.7f) down++;
        }
        float facing = up >= down ? 1 : -1;
        for (int t = 0; t + 2 < tris.Count; t += 3)
        {
            Vector3 a = tris[t], b = tris[t + 1], c = tris[t + 2];
            var n = Vector3.Cross(b - a, c - a);
            var len = n.Length();
            if (len < 1e-6f || facing * n.Y / len < 0.7f) continue; // walls, curbs' faces, ceilings
            used++;
            float x0 = Math.Min(a.X, Math.Min(b.X, c.X)), x1 = Math.Max(a.X, Math.Max(b.X, c.X));
            float z0 = Math.Min(a.Z, Math.Min(b.Z, c.Z)), z1 = Math.Max(a.Z, Math.Max(b.Z, c.Z));
            if (x1 - x0 > 3000 || z1 - z0 > 3000) continue; // giant ground planes aren't roads
            float det = (b.X - a.X) * (c.Z - a.Z) - (c.X - a.X) * (b.Z - a.Z);
            if (Math.Abs(det) < 1e-6f) continue;
            for (int ix = (int)MathF.Floor(x0 / Px - 0.5f); ix <= (int)MathF.Ceiling(x1 / Px + 0.5f); ix++)
                for (int iz = (int)MathF.Floor(z0 / Px - 0.5f); iz <= (int)MathF.Ceiling(z1 / Px + 0.5f); iz++)
                {
                    float px = (ix + 0.5f) * Px, pz = (iz + 0.5f) * Px;
                    float u = ((b.X - px) * (c.Z - pz) - (c.X - px) * (b.Z - pz)) / det;
                    float v = ((c.X - px) * (a.Z - pz) - (a.X - px) * (c.Z - pz)) / det;
                    float w = 1 - u - v;
                    // Pixels whose center is inside, or within half a pixel of an edge (closes cracks between triangles)
                    if (u < 0 || v < 0 || w < 0)
                    {
                        var p = new Vector2(px, pz);
                        float d = Math.Min(SegDist(p, new(a.X, a.Z), new(b.X, b.Z)), Math.Min(SegDist(p, new(b.X, b.Z), new(c.X, c.Z)), SegDist(p, new(c.X, c.Z), new(a.X, a.Z))));
                        if (d > 0.5f * Px) continue;
                        u = Math.Max(u, 0); v = Math.Max(v, 0); w = Math.Max(w, 0);
                        var s = u + v + w; u /= s; v /= s; w /= s;
                    }
                    insert(ix, iz, u * a.Y + v * b.Y + w * c.Y);
                }
        }
        int N = pxX.Count;
        Console.WriteLine($"  roads: {used} surface triangles ({up} up, {down} down) → {N} pixels");

        // --- Neighbours: the pixel in each of the 8 surrounding columns closest in height, if close enough ---
        var nb = new int[N * 8];
        for (int i = 0; i < N; i++)
            for (int d = 0; d < 8; d++)
            {
                nb[i * 8 + d] = -1;
                if (!head.TryGetValue(Key(pxX[i] + Dirs[d].dx, pxZ[i] + Dirs[d].dz), out var j)) continue;
                float best = MaxStep * ((d & 1) == 1 ? 1.42f : 1f);
                for (; j >= 0; j = next[j])
                {
                    var dh = Math.Abs(pxH[j] - pxH[i]);
                    if (dh <= best) { best = dh; nb[i * 8 + d] = j; }
                }
            }
        // Links must be mutual for thinning to behave; drop one-sided ones
        for (int i = 0; i < N; i++)
            for (int d = 0; d < 8; d++)
            {
                var j = nb[i * 8 + d];
                if (j >= 0 && nb[j * 8 + ((d + 4) & 7)] != i) nb[i * 8 + d] = -1;
            }

        // --- Drop small pieces ---
        var alive = new bool[N];
        var comp = new int[N];
        Array.Fill(comp, -1);
        {
            int cid = 0;
            var stack = new Stack<int>();
            var members = new List<int>();
            for (int s = 0; s < N; s++)
            {
                if (comp[s] >= 0) continue;
                members.Clear();
                comp[s] = cid; stack.Push(s);
                while (stack.Count > 0)
                {
                    var i = stack.Pop(); members.Add(i);
                    for (int d = 0; d < 8; d++) { var j = nb[i * 8 + d]; if (j >= 0 && comp[j] < 0) { comp[j] = cid; stack.Push(j); } }
                }
                if (members.Count >= MinComponentPixels) foreach (var i in members) alive[i] = true;
                cid++;
            }
        }

        // --- Distance to the surface's edge (for widths), in pixels, 8-connected BFS ---
        var dist = new float[N];
        {
            var q = new Queue<int>();
            for (int i = 0; i < N; i++)
            {
                if (!alive[i]) continue;
                bool edge = false;
                for (int d = 0; d < 8 && !edge; d += 2) edge = nb[i * 8 + d] < 0 || !alive[nb[i * 8 + d]];
                dist[i] = edge ? 1 : float.MaxValue;
                if (edge) q.Enqueue(i);
            }
            while (q.Count > 0)
            {
                var i = q.Dequeue();
                for (int d = 0; d < 8; d++)
                {
                    var j = nb[i * 8 + d];
                    var nd = dist[i] + ((d & 1) == 1 ? 1.414f : 1f);
                    if (j >= 0 && alive[j] && nd < dist[j] - 0.01f) { dist[j] = nd; q.Enqueue(j); }
                }
            }
        }

        // --- Zhang-Suen thinning on the layered grid ---
        bool on(int i, int d) { var j = nb[i * 8 + d]; return j >= 0 && alive[j]; }
        var remove = new List<int>();
        var candidates = Enumerable.Range(0, N).Where(i => alive[i]).ToList();
        for (int iter = 0; iter < 500; iter++)
        {
            int removed = 0;
            for (int sub = 0; sub < 2; sub++)
            {
                remove.Clear();
                foreach (var i in candidates)
                {
                    if (!alive[i]) continue;
                    int count = 0, transitions = 0;
                    for (int d = 0; d < 8; d++)
                    {
                        if (on(i, d)) count++;
                        if (!on(i, d) && on(i, (d + 1) & 7)) transitions++;
                    }
                    if (count < 2 || count > 6 || transitions != 1) continue;
                    // P2 = N(0), P4 = E(2), P6 = S(4), P8 = W(6)
                    bool p2 = on(i, 0), p4 = on(i, 2), p6 = on(i, 4), p8 = on(i, 6);
                    if (sub == 0 ? (p2 && p4 && p6) || (p4 && p6 && p8) : (p2 && p4 && p8) || (p2 && p6 && p8)) continue;
                    remove.Add(i);
                }
                foreach (var i in remove) alive[i] = false;
                removed += remove.Count;
            }
            candidates.RemoveAll(i => !alive[i]);
            if (removed == 0) break;
        }
        var skeleton = candidates;
        int degree(int i) { int c = 0; for (int d = 0; d < 8; d++) if (on(i, d)) c++; return c; }

        // --- Trace the skeleton into a graph ---
        // Junction/end pixels (degree ≠ 2), clustered with their junction neighbours into one node each
        var nodeOf = new Dictionary<int, int>();
        var gNodes = new List<List<int>>(); // pixels of each node
        foreach (var s in skeleton)
        {
            if (degree(s) == 2 || nodeOf.ContainsKey(s) || degree(s) == 0) continue;
            var cluster = new List<int>();
            var st = new Stack<int>(); st.Push(s); nodeOf[s] = gNodes.Count;
            while (st.Count > 0)
            {
                var i = st.Pop(); cluster.Add(i);
                for (int d = 0; d < 8; d++)
                {
                    var j = nb[i * 8 + d];
                    if (j >= 0 && alive[j] && degree(j) != 2 && !nodeOf.ContainsKey(j)) { nodeOf[j] = gNodes.Count; st.Push(j); }
                }
            }
            gNodes.Add(cluster);
        }
        var edges = new List<Edge>();
        var visited = new HashSet<long>(); // directed pixel steps already walked
        long step(int a, int b) => ((long)a << 32) | (uint)b;
        void trace(int from, int first)
        {
            if (!visited.Add(step(from, first))) return;
            var path = new List<int> { from };
            int prev = from, cur = first;
            while (true)
            {
                path.Add(cur);
                if (nodeOf.ContainsKey(cur) || (cur == path[0])) break;
                int nxt = -1;
                for (int d = 0; d < 8; d++) { var j = nb[cur * 8 + d]; if (j >= 0 && alive[j] && j != prev) { nxt = j; break; } }
                if (nxt < 0) break;
                visited.Add(step(cur, nxt));
                prev = cur; cur = nxt;
                if (path.Count > 200000) break;
            }
            visited.Add(step(path[^1], path[^2]));
            if (!nodeOf.TryGetValue(path[^1], out var endNode))
            {
                // A pure loop (no junction on it): make its start a node
                if (!nodeOf.ContainsKey(path[0])) { nodeOf[path[0]] = gNodes.Count; gNodes.Add([path[0]]); }
                endNode = nodeOf[path[0]];
            }
            edges.Add(new Edge { A = nodeOf[path[0]], B = endNode, Pixels = path });
        }
        foreach (var (pixel, node) in nodeOf.ToList())
            for (int d = 0; d < 8; d++)
            {
                var j = nb[pixel * 8 + d];
                if (j >= 0 && alive[j] && !(nodeOf.TryGetValue(j, out var o) && o == node)) trace(pixel, j);
            }
        foreach (var s in skeleton)
        {
            if (degree(s) != 2 || nodeOf.ContainsKey(s)) continue;
            bool seen = false;
            for (int d = 0; d < 8 && !seen; d++) { var j = nb[s * 8 + d]; seen = j >= 0 && visited.Contains(step(s, j)); }
            if (seen) continue;
            nodeOf[s] = gNodes.Count; gNodes.Add([s]);
            for (int d = 0; d < 8; d++) { var j = nb[s * 8 + d]; if (j >= 0 && alive[j]) { trace(s, j); break; } }
        }

        Vector3 pos(int i) => new((pxX[i] + 0.5f) * Px, pxH[i], (pxZ[i] + 0.5f) * Px);
        var nodePos = gNodes.Select(c => c.Aggregate(Vector3.Zero, (s, i) => s + pos(i)) / c.Count).ToList();
        foreach (var e in edges) e.Length = PathLength(e.Pixels.Select(pos).ToList());
        Console.WriteLine($"  roads: skeleton {skeleton.Count} px → {gNodes.Count} nodes, {edges.Count} edges");

        // --- Clean up ---
        var g = new Graph(nodePos, edges);
        for (int round = 0; round < 6; round++)
        {
            int changed = 0;
            changed += g.PruneSpurs(SpurLength);
            changed += g.DropDuplicates(pos);
            changed += g.MergeClose(JunctionMerge);
            changed += g.Collapse();
            if (changed == 0) break;
        }
        g.DropSmall(MinGraphLength);
        g.Collapse();

        // --- Resample into output nodes ---
        var outNodes = new List<Vector3>();
        var outLinks = new List<(int, int, int, int)>();
        var idx = new Dictionary<int, int>();
        int nodeIndex(int n) { if (!idx.TryGetValue(n, out var k)) { k = outNodes.Count; idx[n] = k; outNodes.Add(g.Pos[n]); } return k; }
        foreach (var e in g.Edges.Where(e => !e.Dead))
        {
            var pts = e.Pixels.Select(pos).ToList();
            pts[0] = g.Pos[e.A]; pts[^1] = g.Pos[e.B];
            // Smooth heights along the path (pixel heights jitter on bumpy collision)
            var smooth = new List<Vector3>();
            for (int k = 0; k < pts.Count; k++)
            {
                float h = 0; int c = 0;
                for (int m = Math.Max(0, k - 3); m <= Math.Min(pts.Count - 1, k + 3); m++) { h += pts[m].Y; c++; }
                smooth.Add(new Vector3(pts[k].X, k == 0 || k == pts.Count - 1 ? pts[k].Y : h / c, pts[k].Z));
            }
            var keep = Simplify(smooth, SimplifyTolerance);
            var width = 2 * Px * Median(e.Pixels.Where(i => i < dist.Length).Select(i => dist[i] == float.MaxValue ? 1 : dist[i]).ToList());
            int lanes = Math.Clamp((int)MathF.Floor(width / 2 / LaneWidth), 1, 3);
            int prevNode = nodeIndex(e.A);
            for (int k = 1; k < keep.Count; k++)
            {
                var a = smooth[keep[k - 1]]; var b = smooth[keep[k]];
                int pieces = Math.Max(1, (int)MathF.Ceiling(Vector2.Distance(new(a.X, a.Z), new(b.X, b.Z)) / MaxSegment));
                for (int p = 1; p <= pieces; p++)
                {
                    int nodeK;
                    if (k == keep.Count - 1 && p == pieces) nodeK = nodeIndex(e.B);
                    else { nodeK = outNodes.Count; outNodes.Add(Vector3.Lerp(a, b, (float)p / pieces)); }
                    if (nodeK != prevNode) outLinks.Add((prevNode, nodeK, lanes, lanes));
                    prevNode = nodeK;
                }
            }
        }
        Console.WriteLine($"  roads: derived {outNodes.Count} nodes, {outLinks.Count} links, {g.Edges.Count(e => !e.Dead)} roads, {g.Edges.Where(e => !e.Dead).Sum(e => e.Length) / 1000:F1} km");
        return (outNodes, outLinks);
    }

    class Edge
    {
        public int A, B;
        public List<int> Pixels;
        public float Length;
        public bool Dead;
    }

    /// <summary>The traced skeleton graph and its clean-up steps.</summary>
    class Graph(List<Vector3> pos, List<Edge> edges)
    {
        public readonly List<Vector3> Pos = pos;
        public readonly List<Edge> Edges = edges;

        Dictionary<int, List<Edge>> Adjacency()
        {
            var adj = new Dictionary<int, List<Edge>>();
            foreach (var e in Edges.Where(e => !e.Dead))
            {
                if (!adj.TryGetValue(e.A, out var la)) adj[e.A] = la = [];
                la.Add(e);
                if (e.B == e.A) continue;
                if (!adj.TryGetValue(e.B, out var lb)) adj[e.B] = lb = [];
                lb.Add(e);
            }
            return adj;
        }

        public int PruneSpurs(float maxLength)
        {
            var adj = Adjacency();
            int n = 0;
            foreach (var e in Edges.Where(e => !e.Dead && e.A != e.B && e.Length < maxLength))
            {
                int da = adj[e.A].Count(x => !x.Dead), db = adj[e.B].Count(x => !x.Dead);
                if ((da == 1 && db >= 3) || (db == 1 && da >= 3)) { e.Dead = true; n++; }
            }
            return n;
        }

        /// <summary>Two roads between the same junctions that run side by side (around a traffic island, or the two
        /// carriageways of a divided road): keep the shorter. Small self-loops go too.</summary>
        public int DropDuplicates(Func<int, Vector3> pixelPos)
        {
            int n = 0;
            foreach (var e in Edges.Where(e => !e.Dead && e.A == e.B && e.Length < 80)) { e.Dead = true; n++; }
            foreach (var grp in Edges.Where(e => !e.Dead && e.A != e.B).GroupBy(e => (Math.Min(e.A, e.B), Math.Max(e.A, e.B))))
            {
                var list = grp.OrderBy(e => e.Length).ToList();
                var keep = list[0].Pixels.Where((_, k) => k % 4 == 0).Select(pixelPos).ToList();
                for (int k = 1; k < list.Count; k++)
                {
                    // Farthest the other road gets from the kept one
                    float apart = 0;
                    for (int m = 0; m < list[k].Pixels.Count; m += 4)
                    {
                        var p = pixelPos(list[k].Pixels[m]);
                        apart = Math.Max(apart, keep.Min(q => Vector3.DistanceSquared(p, q)));
                    }
                    if (MathF.Sqrt(apart) < 35 && list[k].Length < list[0].Length * 1.5f + 20) { list[k].Dead = true; n++; }
                }
            }
            return n;
        }

        /// <summary>Contract short edges between junctions into one junction.</summary>
        public int MergeClose(float maxLength)
        {
            int n = 0;
            var adj = Adjacency();
            var remap = new Dictionary<int, int>();
            int find(int x) { while (remap.TryGetValue(x, out var y)) x = y; return x; }
            foreach (var e in Edges.Where(e => !e.Dead && e.A != e.B && e.Length < maxLength).OrderBy(e => e.Length).ToList())
            {
                int a = find(e.A), b = find(e.B);
                if (a == b) { e.Dead = true; continue; }
                if (adj[e.A].Count(x => !x.Dead) < 3 && adj[e.B].Count(x => !x.Dead) < 3) continue;
                // Merged junctions move; don't let a chain of merges drag one far from where its roads meet
                if (Vector3.Distance(Pos[a], Pos[b]) > maxLength) continue;
                Pos[a] = (Pos[a] + Pos[b]) / 2;
                remap[b] = a;
                e.Dead = true;
                n++;
            }
            if (n > 0)
                foreach (var e in Edges.Where(e => !e.Dead))
                {
                    int a = find(e.A), b = find(e.B);
                    if (a != e.A) { e.A = a; }
                    if (b != e.B) { e.B = b; }
                }
            return n;
        }

        /// <summary>Join the two roads through every node with exactly two.</summary>
        public int Collapse()
        {
            int n = 0;
            var adj = Adjacency();
            foreach (var node in adj.Keys.ToList())
            {
                var live = adj[node].Where(x => !x.Dead).Distinct().ToList();
                if (live.Count != 2 || live[0].A == live[0].B || live[1].A == live[1].B) continue;
                var e1 = live[0]; var e2 = live[1];
                // Orient e1 to end at node, e2 to start at node
                var p1 = e1.B == node ? e1.Pixels : Enumerable.Reverse(e1.Pixels).ToList();
                var p2 = e2.A == node ? e2.Pixels : Enumerable.Reverse(e2.Pixels).ToList();
                int start = e1.B == node ? e1.A : e1.B, end = e2.A == node ? e2.B : e2.A;
                e1.Pixels = [.. p1, .. p2.Skip(1)];
                e1.A = start; e1.B = end; e1.Length += e2.Length;
                e2.Dead = true;
                adj[node].Clear();
                adj[end].Remove(e2);
                if (!adj[end].Contains(e1)) adj[end].Add(e1);
                n++;
            }
            return n;
        }

        public void DropSmall(float minLength)
        {
            var adj = Adjacency();
            var seen = new HashSet<int>();
            foreach (var start in adj.Keys)
            {
                if (seen.Contains(start)) continue;
                var nodes = new List<int>(); var st = new Stack<int>(); st.Push(start); seen.Add(start);
                var comp = new HashSet<Edge>();
                while (st.Count > 0)
                {
                    var x = st.Pop(); nodes.Add(x);
                    foreach (var e in adj[x]) { comp.Add(e); foreach (var y in new[] { e.A, e.B }) if (seen.Add(y)) st.Push(y); }
                }
                if (comp.Sum(e => e.Length) < minLength) foreach (var e in comp) e.Dead = true;
            }
        }
    }

    static float SegDist(Vector2 p, Vector2 a, Vector2 b)
    {
        var ab = b - a;
        var t = Math.Clamp(Vector2.Dot(p - a, ab) / Math.Max(1e-9f, ab.LengthSquared()), 0, 1);
        return Vector2.Distance(p, a + ab * t);
    }

    static float PathLength(List<Vector3> pts)
    {
        float l = 0;
        for (int i = 1; i < pts.Count; i++) l += Vector3.Distance(pts[i - 1], pts[i]);
        return l;
    }

    static float Median(List<float> v)
    {
        if (v.Count == 0) return 1;
        v.Sort();
        return v[v.Count / 2];
    }

    /// <summary>Douglas-Peucker in XZ: indices of the points to keep.</summary>
    static List<int> Simplify(List<Vector3> pts, float tol)
    {
        var keep = new bool[pts.Count];
        keep[0] = keep[^1] = true;
        var stack = new Stack<(int, int)>();
        stack.Push((0, pts.Count - 1));
        while (stack.Count > 0)
        {
            var (a, b) = stack.Pop();
            if (b <= a + 1) continue;
            var pa = new Vector2(pts[a].X, pts[a].Z); var pb = new Vector2(pts[b].X, pts[b].Z);
            int best = -1; float bestD = tol;
            for (int i = a + 1; i < b; i++)
            {
                var d = SegDist(new Vector2(pts[i].X, pts[i].Z), pa, pb);
                // Keep height changes too (crests, dips): 1 m off the straight line counts
                var t = (float)(i - a) / (b - a);
                d = Math.Max(d, Math.Abs(pts[i].Y - (pts[a].Y + (pts[b].Y - pts[a].Y) * t)));
                if (d > bestD) { bestD = d; best = i; }
            }
            if (best < 0) continue;
            keep[best] = true;
            stack.Push((a, best)); stack.Push((best, b));
        }
        return Enumerable.Range(0, pts.Count).Where(i => keep[i]).ToList();
    }
}
