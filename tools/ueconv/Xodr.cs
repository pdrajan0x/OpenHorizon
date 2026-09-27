// An OpenDRIVE road network (.xodr) → the game's road graph (roads.json: nodes [[x, y, z]…], links
// [[a, b, lanes a→b, lanes b→a]…]). Every road's reference line is traced (lines, arcs, spirals, cubic and
// parametric cubic curves, with its elevation and lane offset), sampled finely, simplified to within
// Tolerance m, and the ends of roads that meet (junction connecting roads start where incoming roads end)
// are merged into one node. Lanes: right-hand traffic, so the right lanes (negative ids) run along the
// road, the left ones against it. A one-way road's line is moved to the middle of its lanes, since the
// game puts a road's two directions either side of its line.
//
// Frames: OpenDRIVE x east, y north, z up (right-handed); CARLA's Unreal world is (x, −y, z) in metres;
// the game frame is Unreal (X, Z, Y) → (x, z, −y).
using System.Globalization;
using System.Xml.Linq;

static class Xodr
{
    const double Step = 1.0; // m between samples along a road
    const double Tolerance = 0.4; // m: simplified lines stay this close to the road
    const double MaxSegment = 30; // m: no link longer than this
    const double Merge = 0.75; // m: road ends this close (and within MergeY in height) are one node

    public record Graph(List<(double x, double y, double z)> Nodes, List<(int a, int b, int ab, int ba)> Links, double Km);

    static double D(XElement e, string name) => double.Parse((string)e.Attribute(name) ?? "0", CultureInfo.InvariantCulture);

    record Geometry(double S, double X, double Y, double Hdg, double Length, XElement Shape);
    record Poly(double S, double A, double B, double C, double D)
    {
        public double At(double s) { var ds = s - S; return A + ds * (B + ds * (C + ds * D)); }
    }

    static Poly Pick(List<Poly> list, double s)
    {
        Poly best = null;
        foreach (var p in list) if (p.S <= s + 1e-9) best = p;
        return best ?? list.FirstOrDefault();
    }

    /** Position and heading on one geometry piece at ds metres into it (OpenDRIVE frame). */
    static (double x, double y, double h) Eval(Geometry g, double ds)
    {
        var shape = g.Shape;
        double c = Math.Cos(g.Hdg), s = Math.Sin(g.Hdg);
        switch (shape.Name.LocalName)
        {
            case "arc":
            {
                var k = D(shape, "curvature");
                if (Math.Abs(k) < 1e-12) goto default;
                var h = g.Hdg + k * ds;
                return (g.X + (Math.Sin(h) - s) / k, g.Y - (Math.Cos(h) - c) / k, h);
            }
            case "spiral":
            {
                double c0 = D(shape, "curvStart"), c1 = D(shape, "curvEnd");
                double rate = g.Length > 0 ? (c1 - c0) / g.Length : 0;
                // Integrate the heading numerically
                int n = Math.Max(2, (int)Math.Ceiling(ds / 0.25));
                double x = g.X, y = g.Y, dt = ds / n;
                for (int i = 0; i < n; i++)
                {
                    double t = (i + 0.5) * dt;
                    double h = g.Hdg + c0 * t + rate * t * t / 2;
                    x += Math.Cos(h) * dt;
                    y += Math.Sin(h) * dt;
                }
                return (x, y, g.Hdg + c0 * ds + rate * ds * ds / 2);
            }
            case "poly3":
            {
                double a = D(shape, "a"), b = D(shape, "b"), cc = D(shape, "c"), d = D(shape, "d");
                double u = ds, v = a + u * (b + u * (cc + u * d)), dv = b + u * (2 * cc + 3 * d * u);
                return (g.X + u * c - v * s, g.Y + u * s + v * c, g.Hdg + Math.Atan(dv));
            }
            case "paramPoly3":
            {
                double p = (string)shape.Attribute("pRange") == "normalized" && g.Length > 0 ? ds / g.Length : ds;
                double u = D(shape, "aU") + p * (D(shape, "bU") + p * (D(shape, "cU") + p * D(shape, "dU")));
                double v = D(shape, "aV") + p * (D(shape, "bV") + p * (D(shape, "cV") + p * D(shape, "dV")));
                double du = D(shape, "bU") + p * (2 * D(shape, "cU") + 3 * D(shape, "dU") * p);
                double dv = D(shape, "bV") + p * (2 * D(shape, "cV") + 3 * D(shape, "dV") * p);
                return (g.X + u * c - v * s, g.Y + u * s + v * c, g.Hdg + Math.Atan2(dv, du));
            }
            default:
                return (g.X + ds * c, g.Y + ds * s, g.Hdg);
        }
    }

    public static Graph Read(string path, Func<(double x, double y, double z), (double x, double y, double z)> toGame)
    {
        var doc = XDocument.Load(path);
        var nodes = new List<(double x, double y, double z)>();
        var links = new List<(int a, int b, int ab, int ba)>();
        var grid = new Dictionary<(long, long), List<int>>();
        double km = 0;
        int NodeAt((double x, double y, double z) p, bool end)
        {
            // Road ends merge with any end already there; points along a road are always new
            var key = ((long)Math.Floor(p.x / Merge), (long)Math.Floor(p.z / Merge));
            if (end)
            {
                for (long i = -1; i <= 1; i++)
                    for (long j = -1; j <= 1; j++)
                        if (grid.TryGetValue((key.Item1 + i, key.Item2 + j), out var l))
                            foreach (var k in l)
                            {
                                var q = nodes[k];
                                if (Math.Abs(q.x - p.x) < Merge && Math.Abs(q.z - p.z) < Merge && Math.Abs(q.y - p.y) < 1.5) return k;
                            }
            }
            nodes.Add(p);
            if (end)
            {
                if (!grid.TryGetValue(key, out var list)) grid[key] = list = [];
                list.Add(nodes.Count - 1);
            }
            return nodes.Count - 1;
        }

        foreach (var road in doc.Root!.Elements("road"))
        {
            double length = D(road, "length");
            if (length < 0.5) continue;
            var geoms = road.Element("planView")!.Elements("geometry")
                .Select(g => new Geometry(D(g, "s"), D(g, "x"), D(g, "y"), D(g, "hdg"), D(g, "length"), g.Elements().First())).ToList();
            var elev = road.Element("elevationProfile")?.Elements("elevation").Select(e => new Poly(D(e, "s"), D(e, "a"), D(e, "b"), D(e, "c"), D(e, "d"))).ToList() ?? [];
            var lanesEl = road.Element("lanes")!;
            var offsets = lanesEl.Elements("laneOffset").Select(e => new Poly(D(e, "s"), D(e, "a"), D(e, "b"), D(e, "c"), D(e, "d"))).ToList();
            // Driving lanes each way, and where the middle of them lies (first lane section)
            var section = lanesEl.Elements("laneSection").First();
            int ab = 0, ba = 0;
            double rightMid = 0, leftMid = 0;
            foreach (var (side, sign) in new[] { ("right", -1), ("left", 1) })
            {
                var lanes = section.Element(side)?.Elements("lane").OrderBy(l => Math.Abs((int)l.Attribute("id")!)).ToList() ?? [];
                double t = 0, sum = 0;
                int count = 0;
                foreach (var lane in lanes)
                {
                    var w = lane.Element("width");
                    double width = w != null ? D(w, "a") : 3;
                    if ((string)lane.Attribute("type") == "driving") { sum += t + width / 2; count++; }
                    t += width;
                }
                if (sign < 0) { ab = count; rightMid = count > 0 ? -sum / count : 0; }
                else { ba = count; leftMid = count > 0 ? sum / count : 0; }
            }
            if (ab + ba == 0) continue;
            double shift = ab > 0 && ba > 0 ? 0 : ab > 0 ? rightMid : leftMid;

            // Sample the line: every Step m and at every geometry boundary
            var pts = new List<(double x, double y, double z)>();
            for (double sPos = 0; ; sPos = Math.Min(length, sPos + Step))
            {
                var g = geoms.Last(q => q.S <= sPos + 1e-9);
                var (x, y, h) = Eval(g, Math.Min(g.Length, sPos - g.S));
                var t = (offsets.Count > 0 ? Pick(offsets, sPos).At(sPos) : 0) + shift;
                x += -Math.Sin(h) * t;
                y += Math.Cos(h) * t;
                var z = elev.Count > 0 ? Pick(elev, sPos).At(sPos) : 0;
                pts.Add(toGame((x, y, z)));
                if (sPos >= length) break;
            }
            var keep = Simplify(pts);
            int prev = -1;
            for (int i = 0; i < keep.Count; i++)
            {
                var p = pts[keep[i]];
                int n = NodeAt(p, i == 0 || i == keep.Count - 1);
                if (prev >= 0 && prev != n)
                {
                    links.Add((prev, n, ab, ba));
                    var q = nodes[prev];
                    km += Math.Sqrt((q.x - p.x) * (q.x - p.x) + (q.z - p.z) * (q.z - p.z)) / 1000;
                }
                prev = n;
            }
        }
        return new Graph(nodes, links, km);
    }

    /** One painted line: white or yellow, its width, solid or broken (one line or two side by side), and its path. */
    public record Mark(bool Yellow, double Width, string Type, List<(double x, double y, double z)> Pts, double Dash = 3, double Gap = 6);

    /** A painted patch: a stop bar, a give-way triangle, a zebra stripe (its corners, in order). */
    public record Patch(bool Yellow, List<(double x, double y, double z)> Corners);

    /**
     * The network's road markings (OpenDRIVE roadMark): along each lane's outer edge, and the centre line,
     * wherever a mark is given, traced from the reference line, its lane offset and the lane widths, sampled
     * every metre and simplified to within 5 cm.
     */
    public static (List<Mark> marks, List<Patch> patches) Markings(string path, Func<(double x, double y, double z), (double x, double y, double z)> toGame)
    {
        var doc = XDocument.Load(path);
        var marks = new List<Mark>();
        var patches = new List<Patch>();
        foreach (var road in doc.Root!.Elements("road"))
        {
            double length = D(road, "length");
            if (length < 0.5) continue;
            var geoms = road.Element("planView")!.Elements("geometry")
                .Select(g => new Geometry(D(g, "s"), D(g, "x"), D(g, "y"), D(g, "hdg"), D(g, "length"), g.Elements().First())).ToList();
            var elev = road.Element("elevationProfile")?.Elements("elevation").Select(e => new Poly(D(e, "s"), D(e, "a"), D(e, "b"), D(e, "c"), D(e, "d"))).ToList() ?? [];
            var lanesEl = road.Element("lanes")!;
            var offsets = lanesEl.Elements("laneOffset").Select(e => new Poly(D(e, "s"), D(e, "a"), D(e, "b"), D(e, "c"), D(e, "d"))).ToList();
            var sections = lanesEl.Elements("laneSection").ToList();
            // The road's kind from its driving lanes each way: a wide road's dashes are long, a narrow street's short
            int perSide = sections.Count == 0 ? 0 : new[] { "left", "right" }.Max(side =>
                sections[0].Element(side)?.Elements("lane").Count(l => (string)l.Attribute("type") == "driving") ?? 0);
            var (dash, gap) = perSide >= 3 ? (6.0, 12.0) : perSide == 2 ? (3.0, 6.0) : (3.0, 4.5);
            (double x, double y, double h, double z) At(double sPos)
            {
                var g = geoms.Last(q => q.S <= sPos + 1e-9);
                var (x, y, h) = Eval(g, Math.Min(g.Length, sPos - g.S));
                double t = offsets.Count > 0 ? Pick(offsets, sPos).At(sPos) : 0;
                return (x - Math.Sin(h) * t, y + Math.Cos(h) * t, h, elev.Count > 0 ? Pick(elev, sPos).At(sPos) : 0);
            }
            // Driving lanes' extent across the road at s, on one side (sign +1 left, −1 right): from, to (t)
            (double from, double to) Driving(double sPos, int sign)
            {
                var sec = sections.Last(q => D(q, "s") <= sPos + 1e-9);
                var lanes = sec.Element(sign > 0 ? "left" : "right")?.Elements("lane").OrderBy(l => Math.Abs((int)l.Attribute("id")!)).ToList() ?? [];
                double t = 0, a = double.NaN, b = double.NaN;
                foreach (var lane in lanes)
                {
                    var ws = lane.Elements("width").Select(w => new Poly(D(w, "sOffset"), D(w, "a"), D(w, "b"), D(w, "c"), D(w, "d"))).ToList();
                    double w = ws.Count > 0 ? Pick(ws, sPos - D(sec, "s")).At(sPos - D(sec, "s")) : 0;
                    if ((string)lane.Attribute("type") == "driving") { if (double.IsNaN(a)) a = t; b = t + w; }
                    t += w;
                }
                return (a, b);
            }
            (double x, double y, double z) Point((double x, double y, double h, double z) r, double t, double along)
                => toGame((r.x - Math.Sin(r.h) * t + Math.Cos(r.h) * along, r.y + Math.Cos(r.h) * t + Math.Sin(r.h) * along, r.z));
            // Stop bars at stop signs and traffic lights, give-way triangles at yield signs, across the lanes they govern
            foreach (var sig in road.Element("signals")?.Elements("signal") ?? [])
            {
                var type = (string)sig.Attribute("type");
                if (type is not ("206" or "1000001" or "205")) continue;
                var o = (string)sig.Attribute("orientation");
                if (o is not ("+" or "-")) continue;
                double sp = Math.Clamp(D(sig, "s"), 0.2, length - 0.2);
                int sign = o == "+" ? -1 : 1; // "+": for traffic along s, the right lanes
                var (a, b) = Driving(sp, sign);
                if (double.IsNaN(a) || b - a < 1) continue;
                var r = At(sp);
                if (type == "205")
                {
                    // Shark's teeth: triangles 0.6 wide, 0.6 deep, pointing at the oncoming traffic
                    double dir = sign < 0 ? -1 : 1;
                    for (double t = a + 0.2; t + 0.6 <= b; t += 0.9)
                        patches.Add(new Patch(false, [Point(r, sign * t, 0), Point(r, sign * (t + 0.6), 0), Point(r, sign * (t + 0.3), dir * 0.6)]));
                }
                else
                {
                    double w = 0.4; // m deep
                    patches.Add(new Patch(false, [Point(r, sign * a, -w / 2), Point(r, sign * b, -w / 2), Point(r, sign * b, w / 2), Point(r, sign * a, w / 2)]));
                }
            }
            // Zebra crossings: stripes across the crosswalk outline, 0.5 m wide every metre
            foreach (var obj in road.Element("objects")?.Elements("object") ?? [])
            {
                if ((string)obj.Attribute("type") != "crosswalk") continue;
                double len = D(obj, "length"), wid = D(obj, "width");
                if (len < 1 || wid < 0.5) continue;
                var r = At(Math.Clamp(D(obj, "s"), 0, length));
                double tc = D(obj, "t"), hdg = r.h + D(obj, "hdg");
                (double x, double y, double z) Local(double u, double v)
                {
                    double x0 = r.x - Math.Sin(r.h) * tc, y0 = r.y + Math.Cos(r.h) * tc;
                    return toGame((x0 + Math.Cos(hdg) * u - Math.Sin(hdg) * v, y0 + Math.Sin(hdg) * u + Math.Cos(hdg) * v, r.z));
                }
                for (double u = -len / 2 + 0.25; u + 0.5 <= len / 2; u += 1.0)
                    patches.Add(new Patch(false, [Local(u, -wid / 2), Local(u + 0.5, -wid / 2), Local(u + 0.5, wid / 2), Local(u, wid / 2)]));
            }
            for (int k = 0; k < sections.Count; k++)
            {
                var sec = sections[k];
                double s0 = D(sec, "s");
                double s1 = k + 1 < sections.Count ? D(sections[k + 1], "s") : length;
                if (s1 - s0 < 0.5) continue;
                // Each side's lanes from the centre out, with their width polynomials (relative to the section)
                var sides = new[] { ("left", 1), ("right", -1) }.Select(q => (
                    sign: q.Item2,
                    lanes: sec.Element(q.Item1)?.Elements("lane").OrderBy(l => Math.Abs((int)l.Attribute("id")!)).ToList() ?? []
                )).ToList();
                double WidthOf(XElement lane, double ds)
                {
                    var ws = lane.Elements("width").Select(w => new Poly(D(w, "sOffset"), D(w, "a"), D(w, "b"), D(w, "c"), D(w, "d"))).ToList();
                    return ws.Count > 0 ? Pick(ws, ds).At(ds) : 0;
                }
                // Every edge with marks: the centre lane (the reference line), and each lane's outer edge
                var edges = new List<(XElement lane, int sign, int depth, List<XElement> inner)>();
                var centre = sec.Element("center")?.Element("lane");
                if (centre != null) edges.Add((centre, 0, 0, []));
                foreach (var (sign, lanes) in sides)
                    for (int d = 0; d < lanes.Count; d++) edges.Add((lanes[d], sign, d, lanes.Take(d + 1).ToList()));
                foreach (var (lane, sign, _, inner) in edges)
                {
                    var rms = lane.Elements("roadMark").OrderBy(m => D(m, "sOffset")).ToList();
                    for (int r = 0; r < rms.Count; r++)
                    {
                        var rm = rms[r];
                        var type = ((string)rm.Attribute("type") ?? "none").ToLowerInvariant();
                        if (type is not ("solid" or "broken" or "solid solid" or "solid broken" or "broken solid" or "broken broken")) continue;
                        double m0 = s0 + D(rm, "sOffset");
                        double m1 = r + 1 < rms.Count ? s0 + D(rms[r + 1], "sOffset") : s1;
                        if (m1 - m0 < 0.5) continue;
                        var color = ((string)rm.Attribute("color") ?? "standard").ToLowerInvariant();
                        double width = rm.Attribute("width") != null ? D(rm, "width") : 0.15;
                        if (width <= 0.01) width = 0.15;
                        var pts = new List<(double x, double y, double z)>();
                        for (double sPos = m0; ; sPos = Math.Min(m1, sPos + Step))
                        {
                            var g = geoms.Last(q => q.S <= sPos + 1e-9);
                            var (x, y, h) = Eval(g, Math.Min(g.Length, sPos - g.S));
                            double t = offsets.Count > 0 ? Pick(offsets, sPos).At(sPos) : 0;
                            foreach (var l in inner) t += sign * WidthOf(l, sPos - s0);
                            x += -Math.Sin(h) * t;
                            y += Math.Cos(h) * t;
                            var z = elev.Count > 0 ? Pick(elev, sPos).At(sPos) : 0;
                            pts.Add(toGame((x, y, z)));
                            if (sPos >= m1) break;
                        }
                        var keep = Simplify(pts, 0.05);
                        marks.Add(new Mark(color == "yellow", width, type, keep.Select(i => pts[i]).ToList(), dash, gap));
                    }
                }
            }
        }
        return (marks, patches);
    }

    /** Indices of the points to keep: Douglas–Peucker to Tolerance, no segment longer than MaxSegment. */
    static List<int> Simplify(List<(double x, double y, double z)> p, double tolerance = Tolerance)
    {
        var keep = new SortedSet<int> { 0, p.Count - 1 };
        void Rec(int a, int b)
        {
            if (b <= a + 1) return;
            double best = -1;
            int at = -1;
            var (ax, ay, az) = p[a];
            var (bx, by, bz) = p[b];
            double dx = bx - ax, dy = by - ay, dz = bz - az, len2 = dx * dx + dy * dy + dz * dz;
            for (int i = a + 1; i < b; i++)
            {
                var (x, y, z) = p[i];
                double t = len2 > 0 ? Math.Clamp(((x - ax) * dx + (y - ay) * dy + (z - az) * dz) / len2, 0, 1) : 0;
                double ex = ax + t * dx - x, ey = ay + t * dy - y, ez = az + t * dz - z;
                double d = Math.Sqrt(ex * ex + ey * ey + ez * ez);
                if (d > best) { best = d; at = i; }
            }
            if (best > tolerance || Math.Sqrt(len2) > MaxSegment)
            {
                keep.Add(at);
                Rec(a, at);
                Rec(at, b);
            }
        }
        Rec(0, p.Count - 1);
        return keep.ToList();
    }
}
