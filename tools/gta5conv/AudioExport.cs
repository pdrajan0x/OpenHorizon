// Audio conversion: GTA V sound mods (.awc wave containers plus .rel sound metadata, loose, inside
// .rpf archives or .oiv packages) and plain audio files → browser audio files and a manifest.
//
//   gta5conv audio <input.awc|.rpf|.oiv|dir> <outdir> [--id ID] [--kind engine|crash|skid|ambience|misc]
//                  [--cars a,b] [--title T] [--wav] [--max-seconds N]
//   gta5conv audio --xml <file.awc|file.rel ...>        dump CodeWalker's XML view (for inspection)
//
// One call writes one sound set: <outdir>/<awc>/<stream>.ogg (Opus when ffmpeg exists, else WAV) and
// <outdir>/manifest.json, then refreshes <outdir>/../index.json, the list of all sets the game reads.
//
// What a GTA V engine mod holds: a "granular" engine. Each of six streams (engine/exhaust × accel/
// decel/idle) is a recorded RPM sweep cut into grains, one engine cycle each, and the "granulargrains"
// chunk lists each grain's start sample and frequency in Hz. The game resamples grains to the
// frequency of the current revs; the .rel GranularSound says which stream plays which role and the
// clock range (Hz at revs 0..1), and GranularEngineAudioSettings holds mix levels and rev limiter.
// The manifest keeps all of that (grain starts in seconds, so it's independent of the decode rate).
using System.Diagnostics;
using System.IO.Compression;
using System.Text.Json;
using System.Text.Json.Nodes;
using CodeWalker.GameFiles;

static class AudioExport
{
    const int OpusBitrateKbps = 96; // transparent enough for engine grains, ~12x smaller than WAV
    const int OpusRate = 48000; // libopus only encodes at 48 kHz (and lower telephony rates)
    const uint AwcIdMask = 0x1FFFFFFF; // AWC stores 29-bit wave name hashes
    const int SpectrumFrame = 2048;
    const int SpectrumFrames = 24;

    // Granular channel order in a Dat54 GranularSound, confirmed by the stream names in engine mods
    static readonly string[] GranularRoles = ["engineAccel", "exhaustAccel", "engineDecel", "exhaustDecel", "engineIdle", "exhaustIdle"];

    // Wave names that CodeWalker's hash index may not know, so hashed stream ids resolve to names
    static readonly string[] KnownWaveNames =
    [
        "engine_accel", "exhaust_accel", "engine_decel", "exhaust_decel", "engine_idle", "exhaust_idle",
        "engine_accel_npc", "exhaust_accel_npc", "start_up", "startup", "shut_down", "shutdown", "ignition",
        "limiter", "rev_limiter", "exhaust_pops", "backfire", "dump_valve", "turbo", "turbo_whine",
        "skid", "skids", "tyre_squeal", "tire_squeal", "tyre_skid", "screech", "crash", "impact", "collision",
    ];

    // Keyword → role for one-shots and loops, matched against resolved stream or sound names
    static readonly (string key, string role)[] RoleKeywords =
    [
        ("limiter_pop", "limiterPop"), ("exhaust_pop", "exhaustPop"), ("backfire", "exhaustPop"),
        ("dump_valve", "dumpValve"), ("blow_off", "dumpValve"), ("start_up", "startUp"), ("startup", "startUp"),
        ("ignition", "ignition"), ("shut_down", "shutdown"), ("shutdown", "shutdown"), ("door", "door"),
        ("skid", "skid"), ("squeal", "skid"), ("screech", "skid"), ("drift", "skid"),
        ("crash", "crash"), ("collision", "crash"), ("impact", "crash"), ("smash", "crash"), ("glass", "glass"),
        ("ambien", "ambience"), ("city", "ambience"), ("traffic", "ambience"), ("street", "ambience"),
        ("turbo", "turbo"), ("gear", "gear"),
    ];

    static readonly string[] LooseAudio = [".wav", ".ogg", ".mp3", ".flac", ".opus", ".m4a", ".aac", ".wma"];

    record Source(string Path, byte[] Data);

    public static void Run(string[] args)
    {
        if (args.Length > 0 && args[0] == "--xml") { DumpXml(args[1..]); return; }

        var positional = new List<string>();
        string id = null, kind = null, title = null;
        var cars = new List<string>();
        bool forceWav = false;
        double maxSeconds = 0;
        for (int i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--id": id = args[++i]; break;
                case "--kind": kind = args[++i]; break;
                case "--title": title = args[++i]; break;
                case "--cars": cars.AddRange(args[++i].Split(',', StringSplitOptions.RemoveEmptyEntries)); break;
                case "--wav": forceWav = true; break;
                case "--max-seconds": maxSeconds = double.Parse(args[++i]); break;
                default: positional.Add(args[i]); break;
            }
        }
        if (positional.Count != 2)
        {
            Console.Error.WriteLine("usage: gta5conv audio <input.awc|.rpf|.oiv|dir> <outdir> [--id ID] [--kind K] [--cars a,b] [--title T] [--wav] [--max-seconds N]");
            return;
        }
        var input = positional[0];
        var outDir = positional[1];
        id ??= Path.GetFileName(Path.TrimEndingDirectorySeparator(Path.GetFullPath(outDir)));

        var sources = new List<Source>();
        Gather(input, sources);
        var awcs = sources.Where(s => s.Path.EndsWith(".awc", StringComparison.OrdinalIgnoreCase)).ToList();
        var rels = sources.Where(s => s.Path.EndsWith(".rel", StringComparison.OrdinalIgnoreCase)).ToList();
        var loose = sources.Where(s => LooseAudio.Contains(Path.GetExtension(s.Path).ToLowerInvariant())).ToList();
        Console.WriteLine($"{input}: {awcs.Count} awc, {rels.Count} rel, {loose.Count} loose audio");

        // Names first: hashed ids in .rel and .awc only resolve if the strings are in the index
        foreach (var n in KnownWaveNames) JenkIndex.Ensure(n);
        foreach (var s in sources.Where(s => s.Path.EndsWith(".nametable", StringComparison.OrdinalIgnoreCase)))
            foreach (var n in System.Text.Encoding.ASCII.GetString(s.Data).Split('\0')) if (n.Length > 0) SeedName(n.ToLowerInvariant());

        var meta = new RelMeta();
        foreach (var r in rels) meta.Add(r);

        bool opus = !forceWav && HasFfmpeg();
        Directory.CreateDirectory(outDir);
        var streams = new JsonArray();
        var streamInfo = new Dictionary<string, JsonObject>(); // "awc/name" → stream entry
        long totalBytes = 0;

        foreach (var src in awcs)
        {
            var awcName = Path.GetFileNameWithoutExtension(src.Path).ToLowerInvariant();
            var awc = new AwcFile();
            try
            {
                var entry = new RpfBinaryFileEntry { Name = Path.GetFileName(src.Path), NameLower = Path.GetFileName(src.Path).ToLowerInvariant() };
                awc.Load(src.Data, entry);
            }
            catch (Exception e) { Console.Error.WriteLine($"  {src.Path}: {e.Message.Split('\n')[0]} (encrypted or unsupported)"); continue; }
            if (awc.ErrorMessage != null) { Console.Error.WriteLine($"  {src.Path}: {awc.ErrorMessage}"); continue; }

            foreach (var group in StereoGroups(awc))
            {
                var first = group[0];
                var name = group.Length == 2 ? StripSuffix(StreamName(first, meta), "_left") : StreamName(first, meta);
                var key = $"{awcName}/{name}";
                if (streamInfo.ContainsKey(key)) key = $"{awcName}/{name}_{first.Hash.Hex.ToLowerInvariant()}";
                short[][] pcm;
                try { pcm = group.Select(Pcm).ToArray(); }
                catch (Exception e) { Console.Error.WriteLine($"  {key}: {e.Message.Split('\n')[0]}"); continue; }
                if (pcm.Any(p => p == null || p.Length == 0)) { Console.Error.WriteLine($"  {key}: unsupported codec {first.Type}"); continue; }
                int rate = first.SamplesPerSecond;
                int samples = pcm.Min(p => p.Length);
                if (maxSeconds > 0) samples = Math.Min(samples, (int)(maxSeconds * rate));

                var file = $"{awcName}/{Path.GetFileName(key)}.{(opus ? "ogg" : "wav")}";
                var bytes = Encode(pcm, samples, rate, opus);
                var path = Path.Combine(outDir, file);
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                File.WriteAllBytes(path, bytes);
                totalBytes += bytes.Length;

                var fc = first.FormatChunk;
                var info = new JsonObject
                {
                    ["id"] = key, ["name"] = Path.GetFileName(key), ["awc"] = awcName, ["file"] = file,
                    ["hash"] = "0x" + first.Hash.Hex, ["channels"] = pcm.Length, ["sampleRate"] = rate,
                    ["samples"] = samples, ["duration"] = Round((double)samples / rate, 4), ["bytes"] = bytes.Length,
                };
                if (fc != null && fc.LoopPoint >= 0) info["loopStart"] = Round((double)fc.LoopPoint / rate, 4);
                var headroom = fc?.Headroom ?? first.StreamFormat?.Headroom ?? 0;
                info["headroomDb"] = headroom / 100.0;
                Analyse(pcm[0], samples, rate, info);
                var soundName = meta.SoundForWave(first.Hash);
                if (soundName != null) info["sound"] = soundName;
                var role = RoleFor(name, soundName, kind);
                if (role != null) info["role"] = role;
                var grains = Grains(first, rate, samples);
                if (grains != null) info["grains"] = grains;
                streams.Add(info);
                streamInfo[key] = info;
                Console.WriteLine($"  {file}  {samples / (double)rate,6:F2}s {rate} Hz {pcm.Length}ch {role ?? ""}{(grains != null ? $" grains={grains["hz"]!.AsArray().Count}" : "")}  {bytes.Length / 1024} KB");
            }
        }

        foreach (var src in loose)
        {
            var name = Sanitize(Path.GetFileNameWithoutExtension(src.Path));
            var key = $"loose/{name}";
            for (int n = 2; streamInfo.ContainsKey(key); n++) key = $"loose/{name}_{n}";
            var file = $"{key}.{(opus ? "ogg" : "wav")}";
            var path = Path.Combine(outDir, file);
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            var probe = Transcode(src.Data, path, opus, maxSeconds);
            if (probe == null) { Console.Error.WriteLine($"  {src.Path}: ffmpeg could not decode it"); continue; }
            var bytes = new FileInfo(path).Length;
            totalBytes += bytes;
            var info = new JsonObject
            {
                ["id"] = key, ["name"] = Path.GetFileName(key), ["file"] = file, ["source"] = Path.GetFileName(src.Path),
                ["channels"] = probe.Value.channels, ["sampleRate"] = probe.Value.rate, ["samples"] = probe.Value.pcm.Length / probe.Value.channels,
                ["duration"] = Round((double)probe.Value.pcm.Length / probe.Value.channels / probe.Value.rate, 4), ["bytes"] = bytes,
            };
            Analyse(Mono(probe.Value.pcm, probe.Value.channels), probe.Value.pcm.Length / probe.Value.channels, probe.Value.rate, info);
            var role = RoleFor(name, null, kind);
            if (role != null) info["role"] = role;
            streams.Add(info);
            streamInfo[key] = info;
            Console.WriteLine($"  {file}  {info["duration"]}s {role ?? ""} {bytes / 1024} KB");
        }

        var engines = meta.Engines(streamInfo);
        if (engines.Count == 0) engines = EnginesByName(streamInfo);
        kind ??= engines.Count > 0 ? "engine" : streams.Select(s => s!["role"]?.GetValue<string>()).FirstOrDefault(r => r != null) ?? "misc";

        var manifest = new JsonObject
        {
            ["id"] = id,
            ["kind"] = kind,
            ["title"] = title ?? id,
            ["cars"] = new JsonArray(cars.Select(c => (JsonNode)c).ToArray()),
            ["codec"] = opus ? "opus" : "pcm",
            ["source"] = new JsonArray(awcs.Concat(loose).Select(s => (JsonNode)RelativeSource(s.Path)).ToArray()),
            ["bytes"] = totalBytes,
            ["engines"] = engines,
            ["streams"] = streams,
        };
        File.WriteAllText(Path.Combine(outDir, "manifest.json"), manifest.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        WriteIndex(Path.GetDirectoryName(Path.GetFullPath(Path.TrimEndingDirectorySeparator(outDir)))!);
        Console.WriteLine($"{outDir}: {streams.Count} streams, {engines.Count} engine setups, {totalBytes / 1024} KB ({(opus ? "opus" : "wav")})");
    }

    // ---------------------------------------------------------------- inputs

    /// <summary>Collects audio-related files from a file, directory, RPF archive or OIV/zip package.</summary>
    static void Gather(string path, List<Source> into)
    {
        if (Directory.Exists(path))
        {
            foreach (var f in Directory.EnumerateFiles(path, "*", SearchOption.AllDirectories).Order()) GatherFile(f, File.ReadAllBytes, into);
            return;
        }
        GatherFile(path, File.ReadAllBytes, into);
    }

    static void GatherFile(string path, Func<string, byte[]> read, List<Source> into)
    {
        var ext = Path.GetExtension(path).ToLowerInvariant();
        if (ext == ".awc" || ext == ".rel" || ext == ".nametable" || LooseAudio.Contains(ext)) into.Add(new Source(path, read(path)));
        else if (ext == ".rpf" && File.Exists(path)) GatherRpf(path, into);
        else if ((ext == ".oiv" || ext == ".zip") && File.Exists(path)) GatherZip(path, into);
    }

    /// <summary>Reads an unencrypted RPF7 (what OpenIV writes) including nested archives, in memory.</summary>
    static void GatherRpf(string path, List<Source> into)
    {
        var rpf = new RpfFile(Path.GetFullPath(path), Path.GetFileName(path));
        try { rpf.ScanStructure(null, _ => { }); }
        catch (Exception e) { Console.Error.WriteLine($"  {path}: {e.Message.Split('\n')[0]}"); return; }
        if (rpf.LastError != null) Console.Error.WriteLine($"  {path}: {rpf.LastError.Split('\n')[0]}");
        void walk(RpfFile f)
        {
            foreach (var entry in f.AllEntries ?? [])
            {
                if (entry is not RpfFileEntry fe) continue;
                var ext = Path.GetExtension(fe.NameLower);
                if (ext != ".awc" && ext != ".rel" && ext != ".nametable" && !LooseAudio.Contains(ext)) continue;
                var data = f.ExtractFile(fe);
                if (data != null) into.Add(new Source(path + "::" + fe.Path.Replace('\\', '/'), data));
            }
            foreach (var child in f.Children ?? []) walk(child);
        }
        walk(rpf);
    }

    /// <summary>OIV packages are zips holding loose files and/or archives.</summary>
    static void GatherZip(string path, List<Source> into)
    {
        using var zip = ZipFile.OpenRead(path);
        var tmp = Path.Combine(Path.GetTempPath(), "gta5conv-audio-" + Guid.NewGuid().ToString("N"));
        try
        {
            foreach (var e in zip.Entries)
            {
                var ext = Path.GetExtension(e.Name).ToLowerInvariant();
                if (ext == ".rpf")
                {
                    // RpfFile reads from disk, so nested archives go through a temp file
                    Directory.CreateDirectory(tmp);
                    var f = Path.Combine(tmp, Guid.NewGuid().ToString("N") + ".rpf");
                    e.ExtractToFile(f);
                    var before = into.Count;
                    GatherRpf(f, into);
                    for (int i = before; i < into.Count; i++) into[i] = into[i] with { Path = into[i].Path.Replace(f, path + "::" + e.FullName) };
                }
                else if (ext == ".awc" || ext == ".rel" || ext == ".nametable" || LooseAudio.Contains(ext))
                {
                    using var s = e.Open();
                    using var ms = new MemoryStream();
                    s.CopyTo(ms);
                    into.Add(new Source(path + "::" + e.FullName, ms.ToArray()));
                }
            }
        }
        finally { if (Directory.Exists(tmp)) Directory.Delete(tmp, true); }
    }

    static void SeedName(string n)
    {
        JenkIndex.Ensure(n);
        // Sound names embed the wave name after a "dlc_<pack>_<pack>_" or "<pack>_" prefix
        var parts = n.Split('_');
        for (int i = 1; i < parts.Length; i++) JenkIndex.Ensure(string.Join('_', parts[i..]));
    }

    // ---------------------------------------------------------------- .rel metadata

    /// <summary>What the .rel sound metadata says about the waves: sound names and engine setups.</summary>
    class RelMeta
    {
        readonly Dictionary<uint, string> soundForWave = [];
        readonly Dictionary<uint, Dat54GranularSound> granular = [];
        readonly List<Dat151GranularEngineAudioSettings> engineSettings = [];
        readonly List<Dat151VehicleEngineAudioSettings> loopEngines = [];
        readonly Dictionary<uint, string> containerOf = [];

        public void Add(Source src)
        {
            var nt = Path.ChangeExtension(src.Path, ".nametable");
            var rel = new RelFile();
            try { rel.Load(src.Data, new RpfBinaryFileEntry { Name = Path.GetFileName(src.Path), NameLower = Path.GetFileName(src.Path).ToLowerInvariant() }); }
            catch (Exception e) { Console.Error.WriteLine($"  {src.Path}: {e.Message.Split('\n')[0]}"); return; }
            foreach (var d in rel.RelDatas ?? [])
            {
                switch (d)
                {
                    case Dat54SimpleSound s:
                        soundForWave.TryAdd(s.FileName.Hash & AwcIdMask, NameOf(s));
                        break;
                    case Dat54GranularSound g:
                        granular[g.NameHash] = g;
                        break;
                    case Dat151GranularEngineAudioSettings ge:
                        engineSettings.Add(ge);
                        break;
                    case Dat151VehicleEngineAudioSettings ve:
                        loopEngines.Add(ve);
                        break;
                }
            }
        }

        static string NameOf(RelData d)
        {
            var s = JenkIndex.TryGetString(d.NameHash);
            return string.IsNullOrEmpty(s) ? d.Name ?? "0x" + d.NameHash.Hex : s;
        }

        public string SoundForWave(MetaHash wave) => soundForWave.TryGetValue(wave.Hash & AwcIdMask, out var s) ? s : null;

        /// <summary>One engine setup per GranularSound whose waves were exported.</summary>
        public JsonArray Engines(Dictionary<string, JsonObject> streams)
        {
            var result = new JsonArray();
            foreach (var (hash, g) in granular)
            {
                GranularSoundFile[] ch = [new(g.Channel0, g.ChannelSettings0, g.ChannelVolume0), new(g.Channel1, g.ChannelSettings1, g.ChannelVolume1),
                    new(g.Channel2, g.ChannelSettings2, g.ChannelVolume2), new(g.Channel3, g.ChannelSettings3, g.ChannelVolume3),
                    new(g.Channel4, g.ChannelSettings4, g.ChannelVolume4), new(g.Channel5, g.ChannelSettings5, g.ChannelVolume5)];
                var layers = new JsonObject();
                var layerDb = new JsonObject();
                var layerClock = new JsonObject();
                for (int i = 0; i < ch.Length; i++)
                {
                    if (ch[i].File.FileName.Hash == 0) continue;
                    var stream = streams.Values.FirstOrDefault(s => ((uint)Convert.ToUInt32(s["hash"]!.GetValue<string>()[2..], 16) & AwcIdMask) == (ch[i].File.FileName.Hash & AwcIdMask)
                        && s["grains"] != null && ContainerMatches(ch[i].File.ContainerName, s["awc"]!.GetValue<string>()));
                    stream ??= streams.Values.FirstOrDefault(s => ((uint)Convert.ToUInt32(s["hash"]!.GetValue<string>()[2..], 16) & AwcIdMask) == (ch[i].File.FileName.Hash & AwcIdMask) && s["grains"] != null);
                    if (stream == null) continue;
                    stream["role"] = GranularRoles[i];
                    layers[GranularRoles[i]] = stream["id"]!.GetValue<string>();
                    layerDb[GranularRoles[i]] = ch[i].VolumeMb / 100.0;
                    layerClock[GranularRoles[i]] = ch[i].Settings.GranularClockIndex;
                }
                if (layers.Count == 0) continue;
                var name = NameOf(g);
                var settings = engineSettings.FirstOrDefault(e => e.EngineAccel == hash || e.ExhaustAccel == hash);
                var npc = settings == null && engineSettings.Any(e => e.NPCEngineAccel == hash || e.NPCExhaustAccel == hash);
                var engine = new JsonObject
                {
                    ["name"] = name,
                    ["player"] = !npc && !name.Contains("npc"),
                    ["layers"] = layers,
                    ["layerDb"] = layerDb,
                    ["layerClock"] = layerClock,
                    ["clockHz"] = new JsonArray(g.GranularClock.Select(c => (JsonNode)new JsonArray(c.X, c.Y)).ToArray()),
                    ["loopPitchRandom"] = g.LoopRandomisationPitchFraction,
                };
                settings ??= engineSettings.FirstOrDefault(e => e.NPCEngineAccel == hash || e.NPCExhaustAccel == hash);
                if (settings != null)
                {
                    engine["mix"] = new JsonObject
                    {
                        ["masterDb"] = settings.MasterVolume / 100.0,
                        ["engineDb"] = settings.EngineVolume_PostSubmix / 100.0,
                        ["exhaustDb"] = settings.ExhaustVolume_PostSubmix / 100.0,
                        ["engineRevsDb"] = settings.EngineRevsVolume_PostSubmix / 100.0,
                        ["exhaustRevsDb"] = settings.ExhaustRevsVolume_PostSubmix / 100.0,
                        ["engineThrottleDb"] = settings.EngineThrottleVolume_PostSubmix / 100.0,
                        ["exhaustThrottleDb"] = settings.ExhaustThrottleVolume_PostSubmix / 100.0,
                        ["engineIdleDb"] = settings.EngineIdleVolume_PostSubmix / 100.0,
                        ["exhaustIdleDb"] = settings.ExhaustIdleVolume_PostSubmix / 100.0,
                    };
                    engine["revLimiter"] = new JsonObject
                    {
                        ["grainsToPlay"] = settings.RevLimiterGrainsToPlay,
                        ["grainsToSkip"] = settings.RevLimiterGrainsToSkip,
                        ["volumeCut"] = settings.RevLimiterVolumeCut,
                    };
                    engine["gearChangeWobble"] = new JsonObject
                    {
                        ["lengthFrames"] = settings.GearChangeWobbleLength,
                        ["speed"] = settings.GearChangeWobbleSpeed,
                        ["pitch"] = settings.GearChangeWobblePitch,
                        ["volume"] = settings.GearChangeWobbleVolume,
                    };
                    if (settings.MinRPMOverride != 0 || settings.MaxRPMOverride != 0)
                        engine["rpmOverride"] = new JsonArray(settings.MinRPMOverride, settings.MaxRPMOverride);
                }
                // One-shots of the same pack that the engine can fire (pops, limiter, blow-off)
                var awc = streams[layers.First().Value!.GetValue<string>()]["awc"]!.GetValue<string>();
                var oneShots = new JsonObject();
                foreach (var s in streams.Values.Where(s => s["awc"]?.GetValue<string>() == awc && s["grains"] == null))
                {
                    var role = s["role"]?.GetValue<string>();
                    if (role == null) continue;
                    if (oneShots[role] is not JsonArray list) oneShots[role] = list = [];
                    list.Add(s["id"]!.GetValue<string>());
                }
                engine["oneShots"] = oneShots;
                result.Add(engine);
            }
            // Player engines first, so the game can take engines[0]
            return new JsonArray(result.OrderBy(e => e!["player"]!.GetValue<bool>() ? 0 : 1).Select(e => e!.DeepClone()).ToArray());
        }

        static bool ContainerMatches(MetaHash container, string awcName)
        {
            var s = JenkIndex.TryGetString(container);
            return string.IsNullOrEmpty(s) ? true : s.EndsWith(awcName, StringComparison.OrdinalIgnoreCase);
        }

        record GranularSoundFile(Dat54GranularSoundFile File, Dat54GranularSoundData Settings, short VolumeMb);
    }

    /// <summary>Without .rel metadata, engine layers are recognized by their wave names.</summary>
    static JsonArray EnginesByName(Dictionary<string, JsonObject> streams)
    {
        var result = new JsonArray();
        foreach (var awc in streams.Values.Where(s => s["grains"] != null).GroupBy(s => s["awc"]?.GetValue<string>()))
        {
            var layers = new JsonObject();
            double lo = double.MaxValue, hi = 0;
            foreach (var s in awc)
            {
                var n = s["name"]!.GetValue<string>();
                var role = GranularRoles.FirstOrDefault(r => Snake(r) == n);
                if (role == null) continue;
                s["role"] = role;
                layers[role] = s["id"]!.GetValue<string>();
                foreach (var hz in s["grains"]!["hz"]!.AsArray()) { lo = Math.Min(lo, hz!.GetValue<double>()); hi = Math.Max(hi, hz!.GetValue<double>()); }
            }
            if (layers.Count == 0) continue;
            result.Add(new JsonObject
            {
                ["name"] = awc.Key,
                ["player"] = !(awc.Key ?? "").Contains("npc"),
                ["layers"] = layers,
                ["clockHz"] = new JsonArray(new JsonArray(Round(lo, 2), Round(hi, 2))),
            });
        }
        return result;
    }

    static string Snake(string camel) => string.Concat(camel.Select(c => char.IsUpper(c) ? "_" + char.ToLowerInvariant(c) : c.ToString()));

    // ---------------------------------------------------------------- streams

    /// <summary>Exportable streams; "x_left"/"x_right" channel pairs of multichannel containers become one stereo file.</summary>
    static IEnumerable<AwcStream[]> StereoGroups(AwcFile awc)
    {
        var list = (awc.Streams ?? []).Where(s => s != awc.MultiChannelSource && s.MidiChunk == null && (s.FormatChunk != null || s.StreamFormat != null)).ToList();
        var used = new HashSet<AwcStream>();
        foreach (var s in list)
        {
            if (used.Contains(s)) continue;
            used.Add(s);
            var n = s.Name;
            if (n.EndsWith("_left"))
            {
                var right = list.FirstOrDefault(o => !used.Contains(o) && o.Name == n[..^5] + "_right");
                if (right != null) { used.Add(right); yield return [s, right]; continue; }
            }
            yield return [s];
        }
    }

    static string StreamName(AwcStream s, RelMeta meta)
    {
        var n = s.Name;
        if (!n.StartsWith("0x")) return Sanitize(n);
        var sound = meta.SoundForWave(s.Hash);
        if (sound != null)
        {
            // "dlc_pack_pack_vehicle_extras_lo_2_exhaust_pop_01" → "vehicle_extras_lo_2_exhaust_pop_01"
            var parts = sound.Split('_');
            int skip = parts[0] == "dlc" && parts.Length > 3 ? 3 : 0;
            return Sanitize(string.Join('_', parts[skip..]));
        }
        return "hash_" + s.Hash.Hex.ToLowerInvariant();
    }

    static string StripSuffix(string s, string suffix) => s.EndsWith(suffix) ? s[..^suffix.Length] : s;

    static string Sanitize(string s)
    {
        var chars = s.ToLowerInvariant().Select(c => char.IsLetterOrDigit(c) ? c : '_').ToArray();
        return new string(chars).Trim('_');
    }

    static string RoleFor(string name, string sound, string kind)
    {
        var text = (name + " " + sound).ToLowerInvariant();
        foreach (var (key, role) in RoleKeywords) if (text.Contains(key)) return role;
        return kind is "crash" or "skid" or "ambience" ? kind : null;
    }

    static short[] Pcm(AwcStream s)
    {
        var codec = s.StreamFormat?.Codec ?? s.FormatChunk?.Codec ?? AwcCodecType.PCM;
        if (codec != AwcCodecType.PCM && codec != AwcCodecType.ADPCM) return null;
        var bytes = s.GetPcmData();
        var pcm = new short[bytes.Length / 2];
        Buffer.BlockCopy(bytes, 0, pcm, 0, pcm.Length * 2);
        return pcm;
    }

    /// <summary>Grain table in seconds and Hz, plus the pack's grain loops (first and last grain).</summary>
    static JsonObject Grains(AwcStream s, int rate, int samples)
    {
        var gc = s.GranularGrainsChunk;
        if (gc?.GranularGrains == null || gc.GranularGrains.Length < 2) return null;
        var g = gc.GranularGrains;
        var o = new JsonObject
        {
            ["start"] = new JsonArray(g.Select(x => (JsonNode)Round((double)x.UnkUint1 / rate, 6)).ToArray()),
            ["hz"] = new JsonArray(g.Select(x => (JsonNode)Round(x.UnkFloat1, 4)).ToArray()),
            // The last grain ends where a next one would start: one period after its start
            ["end"] = Round(Math.Min(samples, g[^1].UnkUint1 + rate / Math.Max(1, g[^1].UnkFloat1)) / rate, 6),
            ["param"] = gc.UnkFloat1,
        };
        var loops = s.GranularLoopsChunk?.GranularLoops;
        if (loops?.Length > 0)
            o["loops"] = new JsonArray(loops.Where(l => l.Grains?.Length > 0).Select(l => (JsonNode)new JsonArray(l.Grains.Min(), l.Grains.Max())).ToArray());
        return o;
    }

    /// <summary>Level and a coarse spectrum, to tell unnamed streams apart (engine vs exhaust, pops vs loops).</summary>
    static void Analyse(short[] pcm, int samples, int rate, JsonObject info)
    {
        double peak = 0, sum = 0;
        for (int i = 0; i < samples; i++) { double v = pcm[i] / 32768.0; peak = Math.Max(peak, Math.Abs(v)); sum += v * v; }
        info["peakDb"] = Round(20 * Math.Log10(Math.Max(peak, 1e-9)), 1);
        info["rmsDb"] = Round(10 * Math.Log10(Math.Max(sum / Math.Max(1, samples), 1e-18)), 1);
        if (samples < SpectrumFrame) return;
        // Average magnitude spectrum over frames spread across the sound → centroid and band energies
        var mag = new double[SpectrumFrame / 2];
        int frames = Math.Min(SpectrumFrames, samples / SpectrumFrame);
        var re = new double[SpectrumFrame];
        var im = new double[SpectrumFrame];
        for (int f = 0; f < frames; f++)
        {
            int start = (int)((long)(samples - SpectrumFrame) * f / Math.Max(1, frames - 1));
            for (int i = 0; i < SpectrumFrame; i++)
            {
                double w = 0.5 - 0.5 * Math.Cos(2 * Math.PI * i / (SpectrumFrame - 1));
                re[i] = pcm[start + i] / 32768.0 * w;
                im[i] = 0;
            }
            Fft(re, im);
            for (int k = 0; k < mag.Length; k++) mag[k] += Math.Sqrt(re[k] * re[k] + im[k] * im[k]);
        }
        double total = 0, weighted = 0, low = 0;
        for (int k = 1; k < mag.Length; k++)
        {
            double hz = (double)k * rate / SpectrumFrame;
            total += mag[k];
            weighted += mag[k] * hz;
            if (hz < 250) low += mag[k];
        }
        if (total <= 0) return;
        info["centroidHz"] = Math.Round(weighted / total);
        info["lowShare"] = Round(low / total, 3); // share of the spectrum under 250 Hz
    }

    static void Fft(double[] re, double[] im)
    {
        int n = re.Length;
        for (int i = 1, j = 0; i < n; i++)
        {
            int bit = n >> 1;
            for (; (j & bit) != 0; bit >>= 1) j ^= bit;
            j ^= bit;
            if (i < j) { (re[i], re[j]) = (re[j], re[i]); (im[i], im[j]) = (im[j], im[i]); }
        }
        for (int len = 2; len <= n; len <<= 1)
        {
            double ang = -2 * Math.PI / len;
            for (int i = 0; i < n; i += len)
                for (int k = 0; k < len / 2; k++)
                {
                    double wr = Math.Cos(ang * k), wi = Math.Sin(ang * k);
                    int a = i + k, b = i + k + len / 2;
                    double xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
                    re[b] = re[a] - xr; im[b] = im[a] - xi;
                    re[a] += xr; im[a] += xi;
                }
        }
    }

    static short[] Mono(short[] interleaved, int channels)
    {
        if (channels == 1) return interleaved;
        var m = new short[interleaved.Length / channels];
        for (int i = 0; i < m.Length; i++)
        {
            int s = 0;
            for (int c = 0; c < channels; c++) s += interleaved[i * channels + c];
            m[i] = (short)(s / channels);
        }
        return m;
    }

    // ---------------------------------------------------------------- encoding

    static bool? ffmpeg;

    static bool HasFfmpeg()
    {
        if (ffmpeg != null) return ffmpeg.Value;
        try
        {
            using var p = Process.Start(new ProcessStartInfo("ffmpeg", "-hide_banner -encoders") { RedirectStandardOutput = true, RedirectStandardError = true });
            var text = p!.StandardOutput.ReadToEnd();
            p.WaitForExit();
            ffmpeg = p.ExitCode == 0 && text.Contains("libopus");
        }
        catch { ffmpeg = false; }
        return ffmpeg.Value;
    }

    static byte[] Wav(short[][] channels, int samples, int rate)
    {
        int ch = channels.Length;
        using var ms = new MemoryStream();
        using var w = new BinaryWriter(ms);
        w.Write("RIFF"u8); w.Write(36 + samples * ch * 2); w.Write("WAVE"u8);
        w.Write("fmt "u8); w.Write(16); w.Write((short)1); w.Write((short)ch); w.Write(rate); w.Write(rate * ch * 2); w.Write((short)(ch * 2)); w.Write((short)16);
        w.Write("data"u8); w.Write(samples * ch * 2);
        for (int i = 0; i < samples; i++) for (int c = 0; c < ch; c++) w.Write(channels[c][i]);
        w.Flush();
        return ms.ToArray();
    }

    static byte[] Encode(short[][] channels, int samples, int rate, bool opus)
    {
        var wav = Wav(channels, samples, rate);
        if (!opus) return wav;
        var args = $"-hide_banner -loglevel error -f wav -i pipe:0 -ar {OpusRate} -c:a libopus -b:a {OpusBitrateKbps * channels.Length}k -vbr on -application audio -f ogg pipe:1";
        return RunFfmpeg(args, wav) ?? wav;
    }

    /// <summary>Loose audio: decode to PCM (for analysis) and write the browser file.</summary>
    static (short[] pcm, int channels, int rate)? Transcode(byte[] data, string outPath, bool opus, double maxSeconds)
    {
        if (!HasFfmpeg())
        {
            if (!Path.GetExtension(outPath).Equals(".wav", StringComparison.OrdinalIgnoreCase)) return null;
            File.WriteAllBytes(outPath, data);
            return ParseWav(data);
        }
        var limit = maxSeconds > 0 ? $"-t {maxSeconds.ToString(System.Globalization.CultureInfo.InvariantCulture)}" : "";
        var wav = RunFfmpeg($"-hide_banner -loglevel error -i pipe:0 {limit} -ac 2 -f wav -acodec pcm_s16le pipe:1", data);
        if (wav == null) return null;
        var parsed = ParseWav(wav);
        if (parsed == null) return null;
        // Mono sources stay mono
        var (pcm, ch, rate) = parsed.Value;
        bool mono = true;
        for (int i = 0; i + 1 < pcm.Length && mono; i += 2) mono = Math.Abs(pcm[i] - pcm[i + 1]) < 2;
        short[][] chans = mono ? [Mono(pcm, 2)] : [Enumerable.Range(0, pcm.Length / 2).Select(i => pcm[i * 2]).ToArray(), Enumerable.Range(0, pcm.Length / 2).Select(i => pcm[i * 2 + 1]).ToArray()];
        var bytes = Encode(chans, chans[0].Length, rate, opus);
        File.WriteAllBytes(outPath, bytes);
        return mono ? (chans[0], 1, rate) : (pcm, 2, rate);
    }

    static (short[] pcm, int channels, int rate)? ParseWav(byte[] wav)
    {
        if (wav.Length < 44 || wav[0] != 'R' || wav[8] != 'W') return null;
        int pos = 12, ch = 0, rate = 0, bits = 0;
        while (pos + 8 <= wav.Length)
        {
            var id = System.Text.Encoding.ASCII.GetString(wav, pos, 4);
            int size = BitConverter.ToInt32(wav, pos + 4);
            if (id == "fmt ") { ch = BitConverter.ToInt16(wav, pos + 10); rate = BitConverter.ToInt32(wav, pos + 12); bits = BitConverter.ToInt16(wav, pos + 22); }
            if (id == "data")
            {
                if (bits != 16 || ch == 0) return null;
                // ffmpeg writes an unknown (max) size when streaming to a pipe
                int len = size <= 0 || pos + 8 + size > wav.Length ? wav.Length - pos - 8 : size;
                var pcm = new short[len / 2];
                Buffer.BlockCopy(wav, pos + 8, pcm, 0, pcm.Length * 2);
                return (pcm, ch, rate);
            }
            pos += 8 + size + (size & 1);
        }
        return null;
    }

    static byte[] RunFfmpeg(string args, byte[] input)
    {
        using var p = Process.Start(new ProcessStartInfo("ffmpeg", args) { RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true })!;
        var output = new MemoryStream();
        var readOut = p.StandardOutput.BaseStream.CopyToAsync(output);
        var readErr = p.StandardError.ReadToEndAsync();
        try { p.StandardInput.BaseStream.Write(input); } catch (IOException) { }
        p.StandardInput.Close();
        readOut.Wait();
        p.WaitForExit();
        if (p.ExitCode != 0) { Console.Error.WriteLine("  ffmpeg: " + readErr.Result.Trim().Split('\n')[0]); return null; }
        return output.ToArray();
    }

    // ---------------------------------------------------------------- index

    /// <summary>index.json lists every set under the audio root, so the game needs one fetch to choose.</summary>
    static void WriteIndex(string root)
    {
        var sets = new JsonArray();
        foreach (var m in Directory.EnumerateFiles(root, "manifest.json", SearchOption.AllDirectories).Order())
        {
            var j = JsonNode.Parse(File.ReadAllText(m))!.AsObject();
            var dir = Path.GetRelativePath(root, Path.GetDirectoryName(m)!).Replace('\\', '/');
            var roles = j["streams"]!.AsArray().Select(s => s!["role"]?.GetValue<string>()).Where(r => r != null).Distinct().Order();
            sets.Add(new JsonObject
            {
                ["id"] = j["id"]!.GetValue<string>(),
                ["dir"] = dir,
                ["kind"] = j["kind"]!.GetValue<string>(),
                ["title"] = j["title"]?.GetValue<string>(),
                ["cars"] = j["cars"]!.DeepClone(),
                ["engines"] = j["engines"]!.AsArray().Count,
                ["roles"] = new JsonArray(roles.Select(r => (JsonNode)r).ToArray()),
                ["bytes"] = j["bytes"]!.GetValue<long>(),
            });
        }
        File.WriteAllText(Path.Combine(root, "index.json"), new JsonObject { ["sets"] = sets }.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
    }

    static string RelativeSource(string p)
    {
        var cwd = Directory.GetCurrentDirectory();
        return p.StartsWith(cwd) ? Path.GetRelativePath(cwd, p.Split("::")[0]) + (p.Contains("::") ? "::" + p.Split("::", 2)[1] : "") : p;
    }

    static double Round(double v, int digits) => Math.Round(v, digits);

    static void DumpXml(string[] paths)
    {
        foreach (var n in KnownWaveNames) JenkIndex.Ensure(n);
        foreach (var path in paths)
        {
            var nt = Path.ChangeExtension(path, ".nametable");
            if (File.Exists(nt)) foreach (var n in File.ReadAllText(nt).Split('\0')) if (n.Length > 0) SeedName(n.ToLowerInvariant());
        }
        foreach (var path in paths)
        {
            var data = File.ReadAllBytes(path);
            var entry = new RpfBinaryFileEntry { Name = Path.GetFileName(path), NameLower = Path.GetFileName(path).ToLowerInvariant() };
            if (path.EndsWith(".rel"))
            {
                var rel = new RelFile(entry);
                rel.Load(data, entry);
                Console.WriteLine(RelXml.GetXml(rel));
            }
            else
            {
                var awc = new AwcFile();
                awc.Load(data, entry);
                Console.WriteLine(AwcXml.GetXml(awc));
            }
        }
    }
}
