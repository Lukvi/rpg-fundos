/*
 * RPGFundos v3
 * MESTRE: escolhe a imagem de cada canal no painel; ela é enviada e publicada automaticamente.
 * Ajustes por canal: escurecimento, desfoque, zoom e posição.
 * JOGADORES: só instalam; os fundos chegam sozinhos.
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { findStoreLazy } from "@webpack";
import { FluxDispatcher, GuildStore, React, SelectedChannelStore, SelectedGuildStore } from "@webpack/common";

// >>> Repositório PÚBLICO do GitHub (usuario/nome) <<<
const DEFAULT_REPO = "Lukvi/rpg-fundos";
const DEFAULT_BRANCH = "main";
// Contêiner externo do chat (inclui cabeçalho, mensagens e barra de digitação)
const DEFAULT_SELECTOR = '[class^="chat_"], [class*=" chat_"]';

const Native = VencordNative.pluginHelpers.RPGFundos as PluginNative<typeof import("./native")>;
const GuildChannelStore = findStoreLazy("GuildChannelStore");

type Entry = { url: string; dim: number; blur: number; zoom: number; x: number; y: number; };
type Mapa = Record<string, Entry>;

const DEF = { dim: 0.6, blur: 0, zoom: 1, x: 50, y: 50 };

const settings = definePluginSettings({
    repo: { type: OptionType.STRING, description: "Repositório dos fundos (usuario/nome)", default: DEFAULT_REPO },
    branch: { type: OptionType.STRING, description: "Branch", default: DEFAULT_BRANCH },
    token: {
        type: OptionType.STRING,
        description: "SÓ PARA O MESTRE: token do GitHub (Contents: Read and write, só neste repositório). Jogadores deixam vazio.",
        default: ""
    },
    intervalo: { type: OptionType.NUMBER, description: "Verificar atualizações a cada quantos segundos", default: 60 },
    seletor: { type: OptionType.STRING, description: "Seletor CSS do contêiner do chat (avançado)", default: DEFAULT_SELECTOR },
    cssExtra: { type: OptionType.STRING, description: "CSS extra (avançado, para ajustes finos)", default: "" },
    local: { type: OptionType.STRING, description: "", default: "{}", hidden: true },
    painel: { type: OptionType.COMPONENT, component: () => <Painel /> }
});

// ---------- utilidades ----------

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const num = (v: any, d: number) => (typeof v === "number" && isFinite(v) ? v : d);

function normalizar(raw: any): Mapa {
    const out: Mapa = {};
    if (!raw || typeof raw !== "object") return out;
    for (const [id, v] of Object.entries<any>(raw)) {
        if (typeof v === "string") out[id] = { url: v, ...DEF };
        else if (v && typeof v.url === "string")
            out[id] = {
                url: v.url,
                dim: num(v.dim, DEF.dim), blur: num(v.blur, DEF.blur),
                zoom: num(v.zoom, DEF.zoom), x: num(v.x, DEF.x), y: num(v.y, DEF.y)
            };
    }
    return out;
}

function lerLocal(): Mapa {
    try { return normalizar(JSON.parse(settings.store.local || "{}")); } catch { return {}; }
}

const rawBase = () => `https://raw.githubusercontent.com/${settings.store.repo}/${settings.store.branch}`;

let remoto: Mapa = {};
let timer: ReturnType<typeof setInterval> | undefined;
let styleEl: HTMLStyleElement | undefined;
const imgCache = new Map<string, string>();
const carregando = new Set<string>();

async function carregarImagem(url: string) {
    if (imgCache.has(url) || carregando.has(url)) return;
    carregando.add(url);
    try {
        imgCache.set(url, await Native.buscarImagem(url));
        aplicar();
    } catch (e) {
        console.warn("[RPGFundos] imagem falhou:", url, e);
    } finally {
        carregando.delete(url);
    }
}

async function baixarRemoto() {
    try {
        const txt = await Native.buscarTexto(`${rawBase()}/fundos.json?t=${Date.now()}`);
        remoto = normalizar(JSON.parse(txt));
        aplicar();
    } catch (e) {
        console.warn("[RPGFundos] não consegui baixar o fundos.json:", e);
    }
}

function aplicar() {
    if (!styleEl) return;
    const id = SelectedChannelStore.getChannelId();
    const e = id ? ({ ...remoto, ...lerLocal() })[id] : undefined;
    if (!e) { styleEl.textContent = ""; return; }

    const src = imgCache.get(e.url);
    if (!src) { styleEl.textContent = ""; carregarImagem(e.url); return; }

    const dim = clamp(e.dim, 0, 0.95);
    const blur = clamp(e.blur, 0, 12);
    const zoom = clamp(e.zoom, 1, 3);
    const x = clamp(e.x, 0, 100);
    const y = clamp(e.y, 0, 100);
    const escala = zoom * (blur > 0 ? 1.06 : 1); // sobra para esconder as bordas do desfoque
    const R = `:is(${settings.store.seletor || DEFAULT_SELECTOR})`;

    styleEl.textContent = `
:root { --chat-background-default: transparent !important; --bg-overlay-chat: transparent !important; }
${R} { position: relative !important; isolation: isolate; overflow: hidden !important; background: transparent !important; }
${R}::before {
  content: ""; position: absolute; inset: 0; z-index: -1; pointer-events: none;
  background-image: linear-gradient(rgba(0,0,0,${dim}), rgba(0,0,0,${dim})), url("${src}");
  background-size: cover; background-position: ${x}% ${y}%;
  transform: scale(${escala}); transform-origin: ${x}% ${y}%;
  ${blur > 0 ? `filter: blur(${blur}px);` : ""}
}
${R} main, ${R} form, ${R} [class*="chatContent_"], ${R} [class*="scroller_"],
${R} [class*="messagesWrapper_"], ${R} [class*="upperContainer_"], ${R} [class*="channelTextArea_"] {
  background: transparent !important;
}
${R} [class*="messageContent_"], ${R} [class*="username_"], ${R} time, ${R} [class*="markup_"] {
  text-shadow: 0 1px 3px rgba(0,0,0,.85);
}
${settings.store.cssExtra || ""}`;
}

async function reduzir(file: File) {
    const bmp = await createImageBitmap(file);
    const escala = Math.min(1, 1920 / bmp.width);
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * escala);
    c.height = Math.round(bmp.height * escala);
    c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
    const dataUrl = c.toDataURL("image/jpeg", 0.85);
    return { dataUrl, base64: dataUrl.split(",")[1] };
}

async function publicarTudo(mapa: Mapa, extras: { caminho: string; base64: string; }[] = []) {
    const { token, repo, branch } = settings.store;
    await Native.publicar({
        token, repo, branch,
        arquivos: [...extras, { caminho: "fundos.json", texto: JSON.stringify(mapa, null, 2) }]
    });
}

// ---------- painel do mestre ----------

function Ajuste(props: { rotulo: string; min: number; max: number; step: number; valor: number; onChange: (v: number) => void; }) {
    return (
        <label style={{ display: "flex", flexDirection: "column", fontSize: 12, gap: 2 }}>
            <span>{props.rotulo}: {Math.round(props.valor * 100) / 100}</span>
            <input type="range" min={props.min} max={props.max} step={props.step} value={props.valor}
                onChange={ev => props.onChange(Number(ev.target.value))} />
        </label>
    );
}

function Painel() {
    const { local } = settings.use(["local"]);
    const guilds = Object.values<any>(GuildStore.getGuilds());
    const [guildId, setGuildId] = React.useState<string>(SelectedGuildStore.getGuildId() ?? guilds[0]?.id ?? "");
    const [status, setStatus] = React.useState("");
    const [sujo, setSujo] = React.useState(false);
    const [, tick] = React.useReducer((x: number) => x + 1, 0);

    let dados: Mapa = {};
    try { dados = normalizar(JSON.parse(local || "{}")); } catch { }

    React.useEffect(() => {
        Promise.all(Object.values(dados).map(e => carregarImagem(e.url))).then(tick);
    }, [local]);

    const canais: any[] = (GuildChannelStore.getChannels(guildId)?.SELECTABLE ?? [])
        .map((x: any) => x.channel)
        .filter((c: any) => c.type === 0 || c.type === 5);

    function gravarLocal(mapa: Mapa) {
        settings.store.local = JSON.stringify(mapa);
        aplicar();
    }

    async function escolher(canalId: string, file?: File) {
        if (!file) return;
        try {
            setStatus("Enviando imagem...");
            const { dataUrl, base64 } = await reduzir(file);
            const caminho = `fundos/${canalId}-${Date.now()}.jpg`;
            const url = `${rawBase()}/${caminho}`;
            imgCache.set(url, dataUrl);
            const novo: Mapa = { ...dados, [canalId]: { ...DEF, ...dados[canalId], url } };
            gravarLocal(novo);
            await publicarTudo(novo, [{ caminho, base64 }]);
            setSujo(false);
            setStatus("Publicado! Os jogadores recebem em alguns minutos.");
        } catch (e: any) {
            setStatus("Erro: " + (e?.message ?? e));
        }
    }

    function remover(canalId: string) {
        const novo = { ...dados };
        delete novo[canalId];
        gravarLocal(novo);
        setSujo(true);
    }

    function mudar(canalId: string, patch: Partial<Entry>) {
        gravarLocal({ ...dados, [canalId]: { ...dados[canalId], ...patch } });
        setSujo(true);
    }

    async function publicarAlteracoes() {
        try {
            setStatus("Publicando...");
            await publicarTudo(dados);
            setSujo(false);
            setStatus("Publicado!");
        } catch (e: any) {
            setStatus("Erro: " + (e?.message ?? e));
        }
    }

    const btn: React.CSSProperties = {
        padding: "6px 10px", borderRadius: 4, border: "none", cursor: "pointer",
        background: "#5865f2", color: "#fff", textAlign: "center"
    };
    const bloco: React.CSSProperties = { padding: "10px 0", borderBottom: "1px solid rgba(255,255,255,.08)" };
    const topo: React.CSSProperties = { display: "grid", gridTemplateColumns: "150px 130px 170px auto", gap: 8, alignItems: "center" };
    const grade: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12, marginTop: 8 };

    return (
        <div style={{ color: "var(--text-normal)" }}>
            {!settings.store.token && (
                <p style={{ color: "#faa61a" }}>Cole seu token do GitHub no campo "token" acima para poder publicar.</p>
            )}
            <p style={{ opacity: .7, fontSize: 13 }}>
                Os ajustes aparecem ao vivo quando você está com aquele canal aberto. Depois de ajustar, clique em "Publicar alterações".
            </p>
            <div style={{ display: "flex", gap: 8, margin: "12px 0", alignItems: "center" }}>
                <select value={guildId} onChange={e => setGuildId(e.target.value)}
                    style={{ padding: 6, background: "#1e1f22", color: "#fff", borderRadius: 4 }}>
                    {guilds.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
                {sujo && <button style={btn} onClick={publicarAlteracoes}>Publicar alterações</button>}
                <span>{status}</span>
            </div>

            {canais.map(c => {
                const e = dados[c.id];
                const prev = e ? imgCache.get(e.url) : undefined;
                return (
                    <div key={c.id} style={bloco}>
                        <div style={topo}>
                            <span># {c.name}</span>
                            <label style={btn}>
                                {e ? "Trocar imagem" : "Escolher imagem"}
                                <input type="file" accept="image/*" style={{ display: "none" }}
                                    onChange={ev => { escolher(c.id, ev.target.files?.[0]); ev.target.value = ""; }} />
                            </label>
                            {e && prev ? (
                                <div style={{ width: 160, height: 90, overflow: "hidden", borderRadius: 4, position: "relative" }}>
                                    <div style={{
                                        position: "absolute", inset: 0,
                                        backgroundImage: `linear-gradient(rgba(0,0,0,${e.dim}),rgba(0,0,0,${e.dim})),url("${prev}")`,
                                        backgroundSize: "cover", backgroundPosition: `${e.x}% ${e.y}%`,
                                        transform: `scale(${e.zoom})`, transformOrigin: `${e.x}% ${e.y}%`,
                                        filter: e.blur ? `blur(${e.blur / 3}px)` : undefined
                                    }} />
                                </div>
                            ) : <span style={{ opacity: .4 }}>{e ? "carregando..." : "sem fundo"}</span>}
                            {e && <button style={{ ...btn, background: "#da373c" }} onClick={() => remover(c.id)}>Remover</button>}
                        </div>
                        {e && (
                            <div style={grade}>
                                <Ajuste rotulo="Escurecimento" min={0} max={0.9} step={0.05} valor={e.dim} onChange={v => mudar(c.id, { dim: v })} />
                                <Ajuste rotulo="Desfoque" min={0} max={12} step={1} valor={e.blur} onChange={v => mudar(c.id, { blur: v })} />
                                <Ajuste rotulo="Zoom" min={1} max={3} step={0.05} valor={e.zoom} onChange={v => mudar(c.id, { zoom: v })} />
                                <Ajuste rotulo="Horizontal" min={0} max={100} step={1} valor={e.x} onChange={v => mudar(c.id, { x: v })} />
                                <Ajuste rotulo="Vertical" min={0} max={100} step={1} valor={e.y} onChange={v => mudar(c.id, { y: v })} />
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}

// ---------- plugin ----------

export default definePlugin({
    name: "RPGFundos",
    description: "Fundo de imagem diferente em cada canal, sincronizado com o mestre do RPG.",
    authors: [{ name: "Mestre", id: 0n }],
    settings,

    start() {
        styleEl = document.createElement("style");
        styleEl.id = "rpg-fundos";
        document.head.appendChild(styleEl);
        FluxDispatcher.subscribe("CHANNEL_SELECT", aplicar);
        baixarRemoto();
        timer = setInterval(baixarRemoto, Math.max(15, settings.store.intervalo || 60) * 1000);
        aplicar();
    },

    stop() {
        FluxDispatcher.unsubscribe("CHANNEL_SELECT", aplicar);
        if (timer) clearInterval(timer);
        styleEl?.remove();
        styleEl = undefined;
    }
});
