// Unpacks a mod's dlc.rpf (OpenIV-style unencrypted archives, including nested RPFs) into loose
// files. Resources are written with their RSC7 header so they load like stream-folder files.
using CodeWalker.GameFiles;

static class RpfExport
{
    public static void Run(string[] args)
    {
        var rpfPath = args[0];
        var outDir = args[1];
        var rpf = new RpfFile(Path.GetFullPath(rpfPath), Path.GetFileName(rpfPath));
        rpf.ScanStructure(null, e => Console.Error.WriteLine(e));
        int files = 0, failed = 0;
        void extract(RpfFile f)
        {
            foreach (var entry in f.AllEntries ?? [])
            {
                if (entry is not RpfFileEntry fe || fe.NameLower.EndsWith(".rpf")) continue;
                var data = f.ExtractFile(fe);
                if (data == null) { failed++; continue; }
                if (fe is RpfResourceFileEntry re) data = ResourceBuilder.AddResourceHeader(re, ResourceBuilder.Compress(data));
                // Entry paths start with the archive's own path; keep the part inside it
                var inner = fe.Path.Replace('\\', '/');
                var target = Path.Combine(outDir, inner);
                Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                File.WriteAllBytes(target, data);
                files++;
            }
            foreach (var child in f.Children ?? []) extract(child);
        }
        extract(rpf);
        Console.WriteLine($"{rpfPath}: {files} files extracted to {outDir}{(failed > 0 ? $", {failed} failed" : "")}{(rpf.LastError != null ? " (error: " + rpf.LastError.Split('\n')[0] + ")" : "")}");
    }
}
