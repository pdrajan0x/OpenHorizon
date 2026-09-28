// A gta5-mods.com page → its current file's direct link and size (for assets/mods.json fileUrl): the page's
// download button leads to a page carrying the files.gta5-mods.com link. Mods hosted elsewhere say so.
//   node scripts/resolve-mod.mjs <page url> [more …]   → one JSON line per page
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const get = (url, referer) => fetch(url, { headers: { 'User-Agent': UA, ...(referer ? { Referer: referer } : {}) } });

for (const page of process.argv.slice(2)) {
  try {
    const html = await (await get(page)).text();
    const title = (html.match(/<title>\s*([^<]*?)\s*-\s*GTA5-Mods/) ?? [])[1]?.trim();
    const author = (html.match(/class="username"[^>]*>([^<]+)</) ?? [])[1];
    const rating = (html.match(/([\d.]+)\s*\/\s*5 stars/) ?? [])[1];
    const downloads = (html.match(/([\d,]+)\s*Downloads/) ?? [])[1];
    const dl = (html.match(/href="(\/vehicles\/[^"]+\/download\/\d+)"/) ?? [])[1];
    if (!dl) { console.log(JSON.stringify({ page, title, error: 'no download link' })); continue; }
    const dpage = new URL(dl, page).href;
    const d = await (await get(dpage, page)).text();
    const file = (d.match(/https:\/\/files\.gta5-mods\.com\/uploads\/[^"'\s<>]+/) ?? [])[0];
    const external = file ? null : (d.match(/https?:\/\/(?:www\.)?(?:mediafire|drive\.google|mega\.nz|patreon|dropbox)[^"'\s<>]+/) ?? [])[0];
    let bytes = null;
    if (file) {
      const h = await fetch(file, { method: 'HEAD', headers: { 'User-Agent': UA, Referer: dpage } });
      bytes = Number(h.headers.get('content-length')) || null;
    }
    console.log(JSON.stringify({ page, title, author, rating: rating && +rating, downloads, fileUrl: file ?? null, external: external ?? null, bytes }));
  } catch (e) {
    console.log(JSON.stringify({ page, error: String(e) }));
  }
  await new Promise((r) => setTimeout(r, 1200));
}
