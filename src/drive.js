/* ============================================================================
 *  Google ドライブの原本を開いて、そのまま上書き保存する
 *  - ログイン: Google Identity Services（アクセストークン方式）
 *  - ファイル選び: Drive API v3 で一覧を取り、この画面の中に出す
 *    （以前は Google Picker を使っていたが、API キーの確かめ方がブラウザによってずれて
 *      「API デベロッパー キーが無効です」と出ることがあり、画面の大きさも合わせられないのでやめた）
 *  - 読み書き: Drive API v3
 *  権限はドライブ全体（drive）。PC のパスからファイルを探して上書きするため。
 *  （Google ドライブのパソコン用アプリで同期した C ドライブのフォルダは、ドライブの「パソコン」に入る）
 * ==========================================================================*/

/* Google Cloud Console で作った値。ページの中で使う公開用の値で、秘密ではない */
export const GOOGLE = {
  clientId: "735606358037-k1u1cesfr0u1hmummenlj1tbr35it7tr.apps.googleusercontent.com",   /* OAuth クライアント ID（…apps.googleusercontent.com） */
  /* 和訳（Cloud Translation API）用の API キー。Google Cloud 側で、使えるサイトを negilab.github.io に、
     使える API を Cloud Translation API に絞っておく。空なら「和訳を表示」は出さない */
  translateKey: "AIzaSyAUdDVF1N04ESyrJH7IlWm5oYR51JD7kN8",
};

const SCOPE = "https://www.googleapis.com/auth/drive";
export const configured = () => !!GOOGLE.clientId;

let tokenClient = null, token = null, tokenExp = 0, pending = null;

/* リンクから開くたびにログインを押さなくて済むよう、有効期限（約1時間）までこの端末に覚えておく */
const TOKEN_KEY = "mdb.gtoken";
try {
  const t = JSON.parse(localStorage.getItem(TOKEN_KEY) || "null");
  if (t && t.scope === SCOPE && t.exp > Date.now()) { token = t.token; tokenExp = t.exp; }
} catch (e) {}
const keepToken = () => { try { localStorage.setItem(TOKEN_KEY, JSON.stringify({ token, exp: tokenExp, scope: SCOPE })); } catch (e) {} };
export const hasToken = () => !!token && Date.now() < tokenExp;

/* 2回目からアカウントを選ばずに済むよう、使ったアカウントのメールアドレスをこの端末に覚えておく */
const EMAIL_KEY = "mdb.gemail";
const getEmail = () => { try { return localStorage.getItem(EMAIL_KEY) || ""; } catch (e) { return ""; } };
const setEmail = v => { try { v ? localStorage.setItem(EMAIL_KEY, v) : localStorage.removeItem(EMAIL_KEY); } catch (e) {} };
async function rememberEmail() {
  if (getEmail()) return;
  try {
    const r = await fetch("https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)", { headers: { Authorization: "Bearer " + token } });
    if (r.ok) setEmail(((await r.json()).user || {}).emailAddress || "");
  } catch (e) { /* 覚えられなくても、次もアカウントを選べば使える */ }
}
let preloading = null;

const loadScript = src => new Promise((res, rej) => {
  if (document.querySelector('script[src="' + src + '"]')) return res();
  const s = document.createElement("script");
  s.src = src; s.async = true; s.onload = res; s.onerror = () => rej(new Error("load " + src));
  document.head.appendChild(s);
});

/* ログインのポップアップは「押した瞬間」に開かないとブロックされるので、部品は前もって読んでおく */
export function preload() {
  if (!configured()) return Promise.resolve();
  return preloading || (preloading = load());
}
async function load() {
  await loadScript("https://accounts.google.com/gsi/client");
  tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE.clientId,
    scope: SCOPE,
    callback: r => {
      const p = pending; pending = null;
      if (!p) return;
      if (r.error) {
        /* 覚えたアカウントで通らなかったときは、次はアカウントを選べるように忘れる */
        setEmail("");
        return p.rej(new Error(r.error));
      }
      token = r.access_token;
      tokenExp = Date.now() + (Number(r.expires_in) || 3600) * 1000 - 60000;
      keepToken();
      rememberEmail();
      p.res(token);
    },
    error_callback: e => { const p = pending; pending = null; if (p) p.rej(Object.assign(new Error(e.type || "popup"), { name: "AbortError" })); },
  });
}
export const ready = () => !!tokenClient;

/* 押した処理の中で、await より前に呼ぶこと（ポップアップのため） */
export function getToken() {
  if (token && Date.now() < tokenExp) return Promise.resolve(token);
  if (!tokenClient) return Promise.reject(new Error("not ready"));
  return new Promise((res, rej) => {
    pending = { res, rej };
    /* 覚えたアカウントがあれば、アカウントを選ぶ画面を出さずに頼む（ログインの窓はすぐ閉じる）。
       ない・通らなかったときは、Google の標準どおりアカウントを選んでもらう */
    const email = getEmail();
    tokenClient.requestAccessToken(email ? { prompt: "", login_hint: email } : { prompt: "select_account" });
  });
}

async function api(url, opts = {}) {
  const t = await getToken();
  const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: "Bearer " + t } });
  if (r.status === 401) { token = null; tokenExp = 0; try { localStorage.removeItem(TOKEN_KEY); } catch (e) {} throw new Error("expired"); }
  if (!r.ok) throw new Error("drive " + r.status);
  return r;
}

const FIELDS = "id,name,mimeType,modifiedTime";

/* 開けるファイルの一覧（新しく更新した順）。q があればファイル名・本文から探す。
   Drive は .md の種類（mimeType）がまちまちなので、文字のファイルを広めに取ってから拡張子で絞る */
const MD = /\.(md|markdown|mkd|mdown|mdx|txt)$/i;
export async function list(tokenPromise, q) {
  await tokenPromise;
  let cond = "trashed = false and mimeType != 'application/vnd.google-apps.folder'" +
    " and (mimeType contains 'text/' or mimeType = 'application/octet-stream' or mimeType = 'application/x-markdown')";
  if (q) cond += " and (name contains " + qstr(q) + " or fullText contains " + qstr(q) + ")";
  const r = await (await api("https://www.googleapis.com/drive/v3/files?q=" + encodeURIComponent(cond) +
    "&orderBy=modifiedTime desc&pageSize=200&fields=files(" + FIELDS + ",parents)" + DRIVE_Q)).json();
  const files = (r.files || []).filter(f => MD.test(f.name)).slice(0, 60);
  /* どのフォルダにあるかを添える（同じ名前のファイルを見分けるため） */
  await Promise.all(files.map(async f => {
    const fo = f.parents && f.parents[0] ? await folder(f.parents[0]) : null;
    f.folder = fo ? fo.name : "";
  }));
  return files.map(f => ({ meta: { id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime }, folder: f.folder }));
}
const folderCache = new Map();
function folder(id) {
  if (!folderCache.has(id)) folderCache.set(id, api("https://www.googleapis.com/drive/v3/files/" + id +
    "?fields=id,name,parents&supportsAllDrives=true").then(r => r.json()).catch(() => null));
  return folderCache.get(id);
}

/* ---- フォルダからたどって選ぶ */
const FOLDER = "application/vnd.google-apps.folder";
/* いちばん上に並べる場所: マイドライブと、PC から同期しているフォルダ（ドライブの「パソコン」）。
   「パソコン」の入口（PC そのもの）は一覧に出てこないので、自分のフォルダの親をたどって見つける */
let rootsCache = null;
export function roots(tokenPromise) {
  return rootsCache || (rootsCache = (async () => {
    await tokenPromise;
    const my = await (await api("https://www.googleapis.com/drive/v3/files/root?fields=id,name")).json();
    const out = [{ id: my.id, name: "マイドライブ", kind: "root" }];
    const ids = new Set(), parents = new Set();
    let page = "";
    for (let n = 0; n < 5; n++) {
      const r = await (await api("https://www.googleapis.com/drive/v3/files?q=" +
        encodeURIComponent("mimeType = '" + FOLDER + "' and trashed = false and 'me' in owners") +
        "&pageSize=1000&fields=nextPageToken,files(id,parents)" + (page ? "&pageToken=" + page : ""))).json();
      for (const f of r.files || []) { ids.add(f.id); (f.parents || []).forEach(x => parents.add(x)); }
      page = r.nextPageToken;
      if (!page) break;
    }
    const tops = [...parents].filter(x => x !== my.id && !ids.has(x)).slice(0, 10);
    const found = await Promise.all(tops.map(folder));
    for (const fo of found) if (fo && fo.id && !(fo.parents && fo.parents.length)) out.push({ id: fo.id, name: fo.name, kind: "pc" });
    return out;
  })().catch(e => { rootsCache = null; throw e; }));
}
/* フォルダの中身: フォルダと md / txt ファイル（フォルダが先、名前順） */
export async function children(tokenPromise, folderId) {
  await tokenPromise;
  const cond = "'" + folderId + "' in parents and trashed = false and (mimeType = '" + FOLDER + "'" +
    " or mimeType contains 'text/' or mimeType = 'application/octet-stream' or mimeType = 'application/x-markdown')";
  let items = [], page = "";
  for (let n = 0; n < 5; n++) {
    const r = await (await api("https://www.googleapis.com/drive/v3/files?q=" + encodeURIComponent(cond) +
      "&orderBy=folder,name&pageSize=1000&fields=nextPageToken,files(" + FIELDS + ")" + DRIVE_Q + (page ? "&pageToken=" + page : ""))).json();
    items = items.concat(r.files || []);
    page = r.nextPageToken;
    if (!page) break;
  }
  return {
    folders: items.filter(f => f.mimeType === FOLDER).map(f => ({ id: f.id, name: f.name })),
    files: items.filter(f => f.mimeType !== FOLDER && MD.test(f.name)).map(f => ({ meta: { id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime } })),
  };
}

/* 原本に上書きする。開いたあとにドライブ側で変わっていたら、confirmChanged() で確かめる */
export async function save(tokenPromise, meta, text, confirmChanged) {
  await tokenPromise;
  const now = await (await api("https://www.googleapis.com/drive/v3/files/" + meta.id + "?fields=" + FIELDS + "&supportsAllDrives=true")).json();
  if (meta.modifiedTime && now.modifiedTime !== meta.modifiedTime && !confirmChanged()) {
    throw Object.assign(new Error("changed"), { name: "AbortError" });
  }
  const r = await api("https://www.googleapis.com/upload/drive/v3/files/" + meta.id + "?uploadType=media&supportsAllDrives=true&fields=" + FIELDS, {
    method: "PATCH",
    headers: { "Content-Type": meta.mimeType && /^text\//.test(meta.mimeType) ? meta.mimeType + "; charset=UTF-8" : "text/markdown; charset=UTF-8" },
    body: text,
  });
  return r.json();
}

/* ============================================================================
 *  PC のパスから、ドライブの中の同じファイルを探す
 *    G:\マイドライブ\a\b.md  → マイドライブの a/b.md
 *    C:\Users\81809\claude\b.md → 同期した「claude」フォルダ（ドライブの「パソコン」）の b.md
 *  ファイル名で探し、見つかった候補の親フォルダをさかのぼって、パスの後ろから何段一致するかで選ぶ。
 * ==========================================================================*/
const DRIVE_Q = "&supportsAllDrives=true&includeItemsFromAllDrives=true&corpora=allDrives";
const qstr = v => "'" + v.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
const ROOT_NAMES = /^(マイドライブ|マイ ドライブ|My Drive)$/i;

export function splitPath(p) {
  return String(p).trim().replace(/^["']|["']$/g, "").replace(/\//g, "\\").split("\\").filter(Boolean);
}

const FIND_Q = "&pageSize=100&fields=files(" + FIELDS + ",parents)" + DRIVE_Q;
const filesWhere = async cond => (await (await api("https://www.googleapis.com/drive/v3/files?q=" +
  encodeURIComponent(cond + " and trashed = false") + FIND_Q)).json()).files || [];
const notFolder = " and mimeType != '" + FOLDER + "'";
/* 親フォルダの名前が分かれば、先にそのフォルダを探して、その中だけからファイルを探す。
   README.md のようにどこにでもある名前は、名前だけで探すと本物が候補から漏れるため */
async function inParent(parentName, n) {
  const dirs = (await (await api("https://www.googleapis.com/drive/v3/files?q=" +
    encodeURIComponent("name = " + qstr(parentName) + " and mimeType = '" + FOLDER + "' and trashed = false") +
    "&pageSize=30&fields=files(id)" + DRIVE_Q)).json()).files || [];
  if (!dirs.length) return [];
  return filesWhere("name = " + qstr(n) + notFolder + " and (" + dirs.map(d => qstr(d.id) + " in parents").join(" or ") + ")");
}
const DRIVE_LETTER = /^[A-Za-z]:$/;

export async function findByPath(tokenPromise, localPath) {
  await tokenPromise;
  const segs = splitPath(localPath);
  const name = segs[segs.length - 1];
  if (!name) return { found: [], name: "" };
  const parent = segs.length > 1 ? segs[segs.length - 2] : "";
  const useParent = parent && !ROOT_NAMES.test(parent) && !DRIVE_LETTER.test(parent);
  /* 親フォルダの中で探し、無ければ名前だけで探す */
  const search = async n => {
    const hit = useParent ? await inParent(parent, n) : [];
    return hit.length ? hit : filesWhere("name = " + qstr(n) + notFolder);
  };
  let files = await search(name);
  /* PC 側だけ「メモ (1).md」のように番号が付いていることがある（Google ドライブのパソコン用アプリが
     同期のときに付ける）。ドライブ側は「メモ.md」なので、見つからなければ番号を外して探し直す */
  const plain = name.replace(/ \(\d+\)(\.[^.]+)$/, "$1");
  if (!files.length && plain !== name) files = await search(plain);
  const folders = new Map();
  const folder = async id => {
    if (!folders.has(id)) folders.set(id, api("https://www.googleapis.com/drive/v3/files/" + id +
      "?fields=id,name,parents&supportsAllDrives=true").then(r => r.json()).catch(() => null));
    return folders.get(id);
  };
  /* 候補ごとに、パスの後ろ（ファイルの親から上）と何段一致するか数える。
     選ばせる画面で見分けがつくよう、一致しなくなっても 4 段までは名前を集める */
  const want = segs.slice(0, -1).reverse().map(s => s.toLowerCase());
  const scored = await Promise.all(files.map(async f => {
    let score = 0, id = f.parents && f.parents[0], names = [], same = true;
    for (let d = 0; id && d < 30; d++) {
      if (!same && names.length >= 4) break;
      const fo = await folder(id);
      if (!fo) { id = null; break; }
      names.push(fo.name);
      const w = want[d];
      same = same && w !== undefined && (fo.name.toLowerCase() === w || (ROOT_NAMES.test(fo.name) && ROOT_NAMES.test(w)));
      if (same) score++;
      id = fo.parents && fo.parents[0];
    }
    const where = (id ? "… / " : "") + names.reverse().join(" / ");
    return { meta: { id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime }, score, where };
  }));
  scored.sort((a, b) => b.score - a.score);
  const best = scored.length ? scored[0].score : 0;
  return { name, found: scored.filter(x => x.score === best), others: scored.length };
}

/* いまのファイルの情報（更新されたかを確かめる） */
export async function meta(tokenPromise, m) {
  await tokenPromise;
  return (await api("https://www.googleapis.com/drive/v3/files/" + m.id + "?fields=" + FIELDS + "&supportsAllDrives=true")).json();
}

export async function read(tokenPromise, meta) {
  await tokenPromise;
  return (await api("https://www.googleapis.com/drive/v3/files/" + meta.id + "?alt=media&supportsAllDrives=true")).text();
}

/* 1つ前の版の中身（変わった所に色を付けるため）。前の版がなければ null。
   PC の Googleドライブ用アプリで同期したファイルは、PC で保存するたびに版が増える */
export async function previous(tokenPromise, meta) {
  await tokenPromise;
  let revs = [], page = "";
  do {
    const r = await (await api("https://www.googleapis.com/drive/v3/files/" + meta.id +
      "/revisions?pageSize=1000&fields=nextPageToken,revisions(id,modifiedTime)" + (page ? "&pageToken=" + page : ""))).json();
    revs = revs.concat(r.revisions || []);
    page = r.nextPageToken;
  } while (page);
  if (revs.length < 2) return null;
  const prev = revs[revs.length - 2];
  return (await api("https://www.googleapis.com/drive/v3/files/" + meta.id + "/revisions/" + prev.id + "?alt=media")).text();
}
