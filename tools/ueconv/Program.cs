// Unreal Engine 4 cooked content (a packaged game's .pak) → Open Horizon map data. See UeMap.cs.
//
//   ueconv ls <Content/Paks dir> [filter]           list the package paths inside the paks
//   ueconv level <root> <level path>                  the actors of one level and what they place
//   ueconv map <root> <level path> <out dir> [--xodr <file.xodr>]   the level and everything it streams in,
//                                                     as the game's map data (UeMap.cs)
// <root> holds <Project>/Content (cooked, loose files) and Engine/Content.
using CUE4Parse.Encryption.Aes;
using CUE4Parse.FileProvider;
using CUE4Parse.UE4.Assets.Exports;
using CUE4Parse.UE4.Assets.Exports.Component;
using CUE4Parse.UE4.Assets.Exports.Component.StaticMesh;
using CUE4Parse.UE4.Objects.Core.Misc;
using CUE4Parse.UE4.Objects.Engine;
using CUE4Parse.UE4.Versions;

static class Program
{
    public static DefaultFileProvider Open(string paks)
    {
        // A packaged game's loose cooked files: <root>/<Project>/Content/… (the game, as /Game) and
        // <root>/Engine/Content/… (as /Engine)
        var root = new DirectoryInfo(paks);
        var project = root.GetDirectories().First(d => d.Name != "Engine" && Directory.Exists(Path.Combine(d.FullName, "Content")));
        var extra = new[] { new DirectoryInfo(Path.Combine(root.FullName, "Engine")) }.Where(d => d.Exists).ToArray();
        var provider = new DefaultFileProvider(project, extra, SearchOption.AllDirectories, new VersionContainer(EGame.GAME_UE4_26), StringComparer.OrdinalIgnoreCase);
        provider.Initialize();
        provider.SubmitKey(new FGuid(), new FAesKey(new byte[32]));
        provider.Mount();
        return provider;
    }

    /** A level by its package path (CarlaUE4/Content/…/Town12 or /Game/…/Town12, with or without .umap). */
    public static UWorld LoadWorld(DefaultFileProvider p, string path)
    {
        path = path.Replace(".umap", "");
        var name = path[(path.LastIndexOf('/') + 1)..];
        return p.LoadPackageObject<UWorld>($"{path}.{name}");
    }

    static int Main(string[] args)
    {
        if (args.Length >= 2 && args[0] == "ls")
        {
            var p = Open(args[1]);
            var filter = args.Length > 2 ? args[2] : "";
            foreach (var f in p.Files.Keys.Where(k => k.Contains(filter, StringComparison.OrdinalIgnoreCase)).Order()) Console.WriteLine(f);
            return 0;
        }
        if (args.Length >= 3 && args[0] == "level")
        {
            var p = Open(args[1]);
            var world = LoadWorld(p, args[2]);
            var level = world.PersistentLevel.Load<ULevel>();
            Console.WriteLine($"{args[2]}: {level.Actors.Length} actors, {world.StreamingLevels?.Length ?? 0} streaming levels");
            foreach (var s in world.StreamingLevels ?? []) Console.WriteLine($"  streaming: {s.Load()?.GetOrDefault<object>("WorldAsset")}");
            var kinds = new Dictionary<string, int>();
            int shown = 0;
            foreach (var a in level.Actors)
            {
                var actor = a?.Load();
                if (actor == null) continue;
                kinds[actor.ExportType] = kinds.GetValueOrDefault(actor.ExportType) + 1;
                if (shown++ < 15)
                {
                    Console.WriteLine($"  {actor.ExportType} {actor.Name}");
                    foreach (var prop in actor.Properties.Take(8)) Console.WriteLine($"     .{prop.Name} = {prop.Tag?.GenericValue?.ToString()?[..Math.Min(120, prop.Tag?.GenericValue?.ToString()?.Length ?? 0)]}");
                }
            }
            foreach (var (k, n) in kinds.OrderByDescending(kv => kv.Value)) Console.WriteLine($"  {n,6} {k}");
            return 0;
        }
        if (args.Length >= 4 && args[0] == "map")
        {
            var i = Array.IndexOf(args, "--xodr");
            UeMap.Write(Open(args[1]), args[2], i > 0 ? args[i + 1] : null, args[3]);
            return 0;
        }
        Console.Error.WriteLine("usage: ueconv ls <paks> [filter] | level <paks> <level>");
        return 1;
    }
}
