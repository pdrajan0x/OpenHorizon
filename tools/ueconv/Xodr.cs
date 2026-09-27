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

    /** Indices of the points to keep: Douglas–Peucker to Tolerance, no segment longer than MaxSegment. */
    static List<int> Simplify(List<(double x, double y, double z)> p)
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
            if (best > Tolerance || Math.Sqrt(len2) > MaxSegment)
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
