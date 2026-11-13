/*
 * RPGFundos v2
 * MESTRE: escolhe a imagem de cada canal no painel; ela é enviada e publicada automaticamente.
 * JOGADORES: só instalam; os fundos chegam sozinhos.
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { findStoreLazy } from "@webpack";
import { FluxDispatcher, GuildStore, React, SelectedChannelStore, SelectedGuildStore } from "@webpack/common";

// >>> Troque pelo seu repositório PÚBLICO do GitHub (usuario/nome) <<<
const DEFAULT_REPO = "SEU_USUARIO/rpg-fundos";
const DEFAULT_BRANCH = "main";
const DEFAULT_SELECTOR = '[class*="chatContent_"]';

const Native = VencordNative.pluginHelpers.RPGFundos as PluginNative<typeof import("./native")>;
const GuildChannelStore = findStoreLazy("GuildChannelStore");

type Entry = { url: string; dim: number; };
type Mapa = Record<string, Entry>;

const settings = definePluginSettings({
    repo: { type: OptionType.STRING, description: "Repositório dos fundos (usuario/nome)", default: DEFAULT_REPO },
    branch: { type: OptionType.STRING, description: "Branch", default: DEFAULT_BRANCH },
    token: {
        type: OptionType.STRING,
        description: "SÓ PARA O MESTRE: token do GitHub (permissão Contents: Read and write, só neste repositório). Jogadores deixam vazio.",
        default: ""
    },
    intervalo: { type: OptionType.NUMBER, description: "Verificar atualizações a cada quantos segundos", default: 60 },
    seletor: { type: OptionType.STRING, description: "Seletor CSS da área de chat (avançado)", default: DEFAULT_SELECTOR },
    local: { type: OptionType.STRING, description: "", default: "{}", hidden: true },
    painel: { type: OptionType.COMPONENT, component: () => <Painel /> }
});

// ---------- utilidades ----------

function normalizar(raw: any): Mapa {
    const out: Mapa = {};
    if (!raw || typeof raw !== "object") return out;
    for (const [id, v] of Object.entries<any>(raw)) {
        if (typeof v === "string") out[id] = { url: v, dim: 0.6 };
        else if (v && typeof v.url === "string")
            out[id] = { url: v.url, dim: typeof v.dim === "number" ? v.dim : 0.6 };
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

    const dim = Math.min(0.95, Math.max(0, e.dim));
    const sel = settings.store.seletor || DEFAULT_SELECTOR;
    styleEl.textContent = `
:root { --chat-background-default: transparent !important; --bg-overlay-chat: transparent !important; }
${sel} {
  background-image: linear-gradient(rgba(0,0,0,${dim}), rgba(0,0,0,${dim})), url("${src}") !important;
  background-size: cover !important;
  background-position: center !important;
}
${sel} main, ${sel} form, ${sel} [class*="scroller_"], ${sel} [class*="messagesWrapper_"] {
  background: transparent !important;
}`;
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
            const novo = { ...dados, [canalId]: { url, dim: dados[canalId]?.dim ?? 0.6 } };
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

    function mudarDim(canalId: string, dim: number) {
        gravarLocal({ ...dados, [canalId]: { ...dados[canalId], dim } });
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
        background: "#5865f2", color: "#fff"
    };
    const linha: React.CSSProperties = {
        display: "grid", gridTemplateColumns: "130px 110px 110px 1fr", gap: 8, alignItems: "center",
        padding: "8px 0", borderBottom: "1px solid rgba(255,255,255,.08)"
    };

    return (
        <div style={{ color: "var(--text-normal)" }}>
            {!settings.store.token && (
                <p style={{ color: "#faa61a" }}>
                    Cole seu token do GitHub no campo "token" acima para poder publicar.
                </p>
            )}
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
                    <div key={c.id} style={linha}>
                        <span># {c.name}</span>
                        <label style={{ ...btn, textAlign: "center" }}>
                            {e ? "Trocar imagem" : "Escolher imagem"}
                            <input type="file" accept="image/*" style={{ display: "none" }}
                                onChange={ev => { escolher(c.id, ev.target.files?.[0]); ev.target.value = ""; }} />
                        </label>
                        <input type="range" min={0} max={0.9} step={0.05} disabled={!e}
                            value={e?.dim ?? 0.6} title="Escurecimento"
                            onChange={ev => mudarDim(c.id, Number(ev.target.value))} />
                        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                            {prev
                                ? <img src={prev} style={{ width: 90, height: 50, objectFit: "cover", borderRadius: 4 }} />
                                : <span style={{ opacity: .4 }}>{e ? "carregando..." : "sem fundo"}</span>}
                            {e && <button style={{ ...btn, background: "#da373c" }} onClick={() => remover(c.id)}>Remover</button>}
                        </div>
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
