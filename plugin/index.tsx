/*
 * RPGFundos v6
 * MESTRE: escolhe a imagem de cada canal no painel; ela é enviada e publicada automaticamente.
 * Ajustes por canal (mestre): escurecimento, desfoque, zoom, posição e degradê.
 * Ajustes pessoais (cada jogador): opacidade, desfoque extra, degradê, canais ocultos, atalho Ctrl+Alt+B.
 * JOGADORES: só instalam; os fundos chegam sozinhos.
 */

import { ChatBarButton } from "@api/ChatButtons";
import { showNotification } from "@api/Notifications";
import { definePluginSettings } from "@api/Settings";
import { ModalCloseButton, ModalContent, ModalHeader, ModalRoot, ModalSize, openModal } from "@utils/modal";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { findStoreLazy } from "@webpack";
import { ChannelStore, FluxDispatcher, GuildStore, React, SelectedChannelStore, SelectedGuildStore } from "@webpack/common";

// >>> Repositório PÚBLICO do GitHub (usuario/nome) <<<
const DEFAULT_REPO = "Lukvi/rpg-fundos";
const DEFAULT_BRANCH = "main";
// Contêiner externo do chat (inclui cabeçalho, mensagens e barra de digitação)
const DEFAULT_SELECTOR = '[class^="chat_"], [class*=" chat_"]';

const Native = VencordNative.pluginHelpers.RPGFundos as PluginNative<typeof import("./native")>;
const GuildChannelStore = findStoreLazy("GuildChannelStore");

type Entry = { url: string; dim: number; blur: number; zoom: number; x: number; y: number; fade: number; inicio: number; guild?: string; canal?: string; };
type Mapa = Record<string, Entry>;

const DEF = { dim: 0.6, blur: 0, zoom: 1, x: 50, y: 50, fade: 100, inicio: 30 };

type Jogador = { ativo: boolean; opacidade: number; desfoque: number; escurecimento: number; degrade: "mestre" | "cheio" | "off"; sombra: boolean; ocultos: string[]; transicao: number; congelarGif: boolean; };
const JOGADOR_DEF: Jogador = { ativo: true, opacidade: 100, desfoque: 0, escurecimento: 0, degrade: "mestre", sombra: true, ocultos: [], transicao: 500, congelarGif: false };

const settings = definePluginSettings({
    repo: { type: OptionType.STRING, description: "Repositório dos fundos (usuario/nome)", default: DEFAULT_REPO },
    branch: { type: OptionType.STRING, description: "Branch", default: DEFAULT_BRANCH },
    token: {
        type: OptionType.STRING,
        description: "SÓ PARA O MESTRE: token do GitHub (Contents: Read and write, só neste repositório). Jogadores deixam vazio.",
        default: ""
    },
    autoAtualizar: {
        type: OptionType.BOOLEAN,
        description: "Atualizar o plugin sozinho ao abrir o Discord (desligado = só avisa)",
        default: false
    },
    intervalo: { type: OptionType.NUMBER, description: "Verificar atualizações a cada quantos segundos", default: 60 },
    seletor: { type: OptionType.STRING, description: "Seletor CSS do contêiner do chat (avançado)", default: DEFAULT_SELECTOR },
    cssExtra: { type: OptionType.STRING, description: "CSS extra (avançado, para ajustes finos)", default: "" },
    local: { type: OptionType.STRING, description: "", default: "{}", hidden: true },
    jogador: { type: OptionType.STRING, description: "", default: "{}", hidden: true },
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
                zoom: num(v.zoom, DEF.zoom), x: num(v.x, DEF.x), y: num(v.y, DEF.y),
                fade: num(v.fade, DEF.fade), inicio: num(v.inicio, DEF.inicio),
                guild: typeof v.guild === "string" ? v.guild : undefined,
                canal: typeof v.canal === "string" ? v.canal : undefined
            };
    }
    return out;
}

function lerLocal(): Mapa {
    try { return normalizar(JSON.parse(settings.store.local || "{}")); } catch { return {}; }
}

function lerJogador(): Jogador {
    try {
        const j = JSON.parse(settings.store.jogador || "{}");
        return { ...JOGADOR_DEF, ...j, ocultos: Array.isArray(j.ocultos) ? j.ocultos : [] };
    } catch { return { ...JOGADOR_DEF }; }
}

function gravarJogador(patch: Partial<Jogador>) {
    settings.store.jogador = JSON.stringify({ ...lerJogador(), ...patch });
    aplicar();
}

const rawBase = () => `https://raw.githubusercontent.com/${settings.store.repo}/${settings.store.branch}`;

const remotoPorServidor: Record<string, Mapa> = {};
const ultimoFetch = new Map<string, number>();
const mapaRemoto = (): Mapa => Object.assign({}, ...Object.values(remotoPorServidor));
const mapaTotal = (): Mapa => ({ ...mapaRemoto(), ...lerLocal() });
let timer: ReturnType<typeof setInterval> | undefined;
let styleEl: HTMLStyleElement | undefined;
let imgStyleEl: HTMLStyleElement | undefined; // guarda só a imagem, para não reprocessar um GIF grande a cada ajuste
let ultimoCss = "";
let ultimaChave = "";
let imgChave = "";
let timerSaida: ReturnType<typeof setTimeout> | undefined;
const estaticos = new Map<string, string>();
const congelando = new Set<string>();
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

function precarregar() {
    const g = SelectedGuildStore.getGuildId();
    for (const [id, e] of Object.entriesmapaTotal())
        if (ChannelStore.getChannel(id)?.guild_id === g) carregarImagem(e.url);
}

async function baixarServidor(guildId: string, forcar = false) {
    if (!guildId) return;
    if (!forcar && Date.now() - (ultimoFetch.get(guildId) ?? 0) < 20000) return;
    ultimoFetch.set(guildId, Date.now());
    const t = Date.now();
    try {
        const txt = await Native.buscarTexto(`${rawBase()}/servidores/${guildId}/fundos.json?t=${t}`);
        remotoPorServidor[guildId] = normalizar(JSON.parse(txt));
    } catch {
        try { // compatibilidade com o formato antigo (um fundos.json só)
            const txt = await Native.buscarTexto(`${rawBase()}/fundos.json?t=${t}`);
            const meus: Mapa = {};
            for (const [id, e] of Object.entries(normalizar(JSON.parse(txt))))
                if (ChannelStore.getChannel(id)?.guild_id === guildId) meus[id] = e;
            remotoPorServidor[guildId] = meus;
        } catch (e) {
            console.warn("[RPGFundos] não consegui baixar os fundos do servidor:", e);
        }
    }
    aplicar();
    precarregar();
}

async function baixarRemoto() {
    await baixarServidor(SelectedGuildStore.getGuildId() ?? "", true);
}

function atalho(ev: KeyboardEvent) {
    if (ev.ctrlKey && ev.altKey && ev.code === "KeyB") {
        ev.preventDefault();
        gravarJogador({ ativo: !lerJogador().ativo });
    }
}

function aoTrocarCanal() {
    baixarServidor(SelectedGuildStore.getGuildId() ?? "");
    aplicar();
    precarregar();
}

function corBase(): string {
    const ok = (c: string) => !!c && c !== "transparent" && !/rgba\(.*,\s*0\)$/.test(c);
    for (const sel of [settings.store.seletor || DEFAULT_SELECTOR, '[class*="chatContent_"]', '[class*="messagesWrapper_"]']) {
        try {
            const el = document.querySelector(sel);
            if (el) {
                const c = getComputedStyle(el).backgroundColor;
                if (ok(c)) return c;
            }
        } catch { }
    }
    const v = getComputedStyle(document.documentElement).getPropertyValue("--chat-background-default").trim();
    return v || "#313338";
}

const raiz = () => `:is(${settings.store.seletor || DEFAULT_SELECTOR})`;

function movimentoReduzido() {
    try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
}

function duracao(J: Jogador) {
    return movimentoReduzido() ? 0 : clamp(J.transicao, 0, 3000);
}

function limpar() {
    if (timerSaida) clearTimeout(timerSaida);
    timerSaida = undefined;
    if (styleEl) styleEl.textContent = "";
    if (imgStyleEl) imgStyleEl.textContent = "";
    ultimoCss = "";
    ultimaChave = "";
    imgChave = "";
}

// Sai do canal com fundo: esmaece em vez de sumir de repente.
function esconder(J: Jogador) {
    if (timerSaida) return;
    if (!styleEl || !ultimoCss) { limpar(); return; }
    const d = duracao(J);
    if (d <= 0) { limpar(); return; }
    const R = raiz();
    styleEl.textContent = `${ultimoCss}\n${R}::before, ${R}::after { animation: rpgFadeOut ${d}ms ease-in forwards !important; }`;
    timerSaida = setTimeout(limpar, d + 50);
}

// Primeiro quadro de um GIF (para quem prefere sem movimento).
async function congelar(url: string, src: string) {
    if (estaticos.has(url) || congelando.has(url)) return;
    congelando.add(url);
    try {
        const img = new Image();
        img.src = src;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext("2d")!.drawImage(img, 0, 0);
        estaticos.set(url, c.toDataURL("image/jpeg", 0.85));
        aplicar();
    } catch (e) {
        console.warn("[RPGFundos] não consegui pausar o GIF:", e);
    } finally {
        congelando.delete(url);
    }
}

function aplicar() {
    if (!styleEl || !imgStyleEl) return;
    const id = SelectedChannelStore.getChannelId();
    const J = lerJogador();
    const e = id ? mapaTotal()[id] : undefined;
    if (!e || !J.ativo || J.ocultos.includes(id)) { esconder(J); return; }

    let src = imgCache.get(e.url);
    if (!src) { carregarImagem(e.url); esconder(J); return; }

    let fonte = e.url;
    if (J.congelarGif && /^data:image\/gif/i.test(src)) {
        const est = estaticos.get(e.url);
        if (est) { src = est; fonte += "#estatico"; }
        else congelar(e.url, src);
    }

    if (timerSaida) { clearTimeout(timerSaida); timerSaida = undefined; }

    const R = raiz();
    styleEl.textContent = ""; // limpa para ler a cor original do Discord
    const cor = corBase();

    const dim = clamp(e.dim + J.escurecimento, 0, 0.95);
    const blur = clamp(e.blur + J.desfoque, 0, 20);
    const zoom = clamp(e.zoom, 1, 3);
    const x = clamp(e.x, 0, 100);
    const y = clamp(e.y, 0, 100);
    const opac = clamp(J.opacidade, 0, 100) / 100;
    const fade = (J.degrade === "off" ? 0 : J.degrade === "cheio" ? 100 : clamp(e.fade, 0, 100)) / 100;
    const inicio = clamp(e.inicio, 0, 80);
    const escala = zoom * (blur > 0 ? 1.06 : 1); // sobra para esconder as bordas do desfoque

    const chaveImg = `${R}|${fonte}`;
    if (chaveImg !== imgChave) {
        imgStyleEl.textContent = `${R}::before { background-image: url("${src}"); }`;
        imgChave = chaveImg;
    }

    const base = `
@keyframes rpgFadeIn { from { opacity: 0; } }
@keyframes rpgFadeOut { to { opacity: 0; } }
:root { --chat-background-default: transparent !important; --bg-overlay-chat: transparent !important; }
${R} { position: relative !important; isolation: isolate; overflow: hidden !important; background: ${cor} !important; }
${R}::before {
  content: ""; position: absolute; inset: 0; z-index: -1; pointer-events: none;
  background-size: cover; background-position: ${x}% ${y}%;
  transform: scale(${escala}); transform-origin: ${x}% ${y}%;
  opacity: ${opac};
  filter: ${blur > 0 ? `blur(${blur}px) ` : ""}brightness(${1 - dim});
}
${R}::after {
  content: ""; position: absolute; inset: 0; z-index: -1; pointer-events: none;
  background: linear-gradient(to bottom, transparent ${inicio}%, ${cor} 90%);
  opacity: ${fade};
}
${R} main, ${R} form, ${R} [class*="chatContent_"], ${R} [class*="scroller_"],
${R} [class*="messagesWrapper_"], ${R} [class*="upperContainer_"], ${R} [class*="channelTextArea_"] {
  background: transparent !important;
}
${J.sombra ? `${R} [class*="messageContent_"], ${R} [class*="username_"], ${R} time, ${R} [class*="markup_"] {
  text-shadow: 0 1px 3px rgba(0,0,0,.85);
}` : ""}
${settings.store.cssExtra || ""}`;

    // só anima quando o canal (ou a imagem) muda, não a cada ajuste de slider
    const chave = `${id}|${fonte}`;
    const d = duracao(J);
    const animar = d > 0 && chave !== ultimaChave;
    ultimaChave = chave;
    ultimoCss = base;
    styleEl.textContent = animar
        ? `${base}\n${R}::before, ${R}::after { animation: rpgFadeIn ${d}ms ease-out; }`
        : base;
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

const LIMITE_GIF = 8 * 1024 * 1024;

async function lerArquivo(file: File): Promise<{ dataUrl: string; base64: string; ext: string; }> {
    if (file.type === "image/gif") {
        if (file.size > LIMITE_GIF)
            throw new Error("GIF grande demais (máximo 8 MB). Reduza as dimensões ou a duração e tente de novo.");
        const dataUrl = await new Promise<string>((res, rej) => {
            const r = new FileReader();
            r.onload = () => res(r.result as string);
            r.onerror = () => rej(new Error("Não consegui ler o arquivo"));
            r.readAsDataURL(file);
        });
        return { dataUrl, base64: dataUrl.split(",")[1], ext: "gif" };
    }
    return { ...(await reduzir(file)), ext: "jpg" };
}

async function publicarTudo(mapa: Mapa, guildAtual: string, extras: { caminho: string; base64: string; }[] = []) {
    const { token, repo, branch } = settings.store;
    const porServidor: Record<string, Mapa> = {};
    if (guildAtual) porServidor[guildAtual] = {};
    for (const [id, e] of Object.entries(mapa)) {
        const g = e.guild ?? ChannelStore.getChannel(id)?.guild_id;
        if (!g) continue;
        (porServidor[g] ??= {})[id] = { ...e, guild: g };
    }
    const arquivos: { caminho: string; base64?: string; texto?: string; }[] = [...extras];
    for (const [g, m] of Object.entries(porServidor))
        arquivos.push({ caminho: `servidores/${g}/fundos.json`, texto: JSON.stringify(m, null, 2) });
    await Native.publicar({ token, repo, branch, arquivos });
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

const estiloBtn: React.CSSProperties = {
    padding: "6px 10px", borderRadius: 4, border: "none", cursor: "pointer",
    background: "#5865f2", color: "#fff", textAlign: "center"
};

function PainelMestre() {
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

    async function escolher(canalId: string, file?: File, nomeCanal?: string) {
        if (!file) return;
        try {
            setStatus("Enviando imagem...");
            const { dataUrl, base64, ext } = await lerArquivo(file);
            const caminho = `servidores/${guildId}/canais/${canalId}/${Date.now()}.${ext}`;
            const url = `${rawBase()}/${caminho}`;
            imgCache.set(url, dataUrl);
            const novo: Mapa = { ...dados, [canalId]: { ...DEF, ...dados[canalId], url, guild: guildId, canal: nomeCanal } };
            gravarLocal(novo);
            await publicarTudo(novo, guildId, [{ caminho, base64 }]);
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

    function aplicarATodos(canalId: string) {
        const base = dados[canalId];
        if (!base) return;
        const novo: Mapa = {};
        for (const [id, e] of Object.entries(dados))
            novo[id] = { ...e, dim: base.dim, blur: base.blur, fade: base.fade, inicio: base.inicio };
        gravarLocal(novo);
        setSujo(true);
        setStatus("Escurecimento, desfoque e degradê copiados para todos os canais. Clique em Publicar alterações.");
    }

    async function publicarAlteracoes() {
        try {
            setStatus("Publicando...");
            await publicarTudo(dados, guildId);
            setSujo(false);
            setStatus("Publicado!");
        } catch (e: any) {
            setStatus("Erro: " + (e?.message ?? e));
        }
    }

    const bloco: React.CSSProperties = { padding: "10px 0", borderBottom: "1px solid rgba(255,255,255,.08)" };
    const topo: React.CSSProperties = { display: "grid", gridTemplateColumns: "150px 130px 170px auto", gap: 8, alignItems: "center" };
    const grade: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginTop: 8 };

    return (
        <div>
            <h3 style={{ margin: "8px 0" }}>Painel do mestre</h3>
            <p style={{ opacity: .7, fontSize: 13 }}>
                Aceita JPG, PNG, WebP e GIF animado (GIF até 8 MB). Os ajustes aparecem ao vivo quando aquele canal está aberto. Depois de ajustar, clique em "Publicar alterações".
            </p>
            <div style={{ display: "flex", gap: 8, margin: "12px 0", alignItems: "center" }}>
                <select value={guildId} onChange={e => setGuildId(e.target.value)}
                    style={{ padding: 6, background: "#1e1f22", color: "#fff", borderRadius: 4 }}>
                    {guilds.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
                {sujo && <button style={estiloBtn} onClick={publicarAlteracoes}>Publicar alterações</button>}
                <span>{status}</span>
            </div>

            {canais.map(c => {
                const e = dados[c.id];
                const prev = e ? imgCache.get(e.url) : undefined;
                return (
                    <div key={c.id} style={bloco}>
                        <div style={topo}>
                            <span># {c.name}</span>
                            <label style={estiloBtn}>
                                {e ? "Trocar imagem" : "Escolher imagem"}
                                <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" style={{ display: "none" }}
                                    onChange={ev => { escolher(c.id, ev.target.files?.[0], c.name); ev.target.value = ""; }} />
                            </label>
                            {e && prev ? (
                                <div style={{ width: 160, height: 90, overflow: "hidden", borderRadius: 4, position: "relative", background: "#313338" }}>
                                    <div style={{
                                        position: "absolute", inset: 0,
                                        backgroundImage: `linear-gradient(rgba(0,0,0,${e.dim}),rgba(0,0,0,${e.dim})),url("${prev}")`,
                                        backgroundSize: "cover", backgroundPosition: `${e.x}% ${e.y}%`,
                                        transform: `scale(${e.zoom})`, transformOrigin: `${e.x}% ${e.y}%`,
                                        filter: e.blur ? `blur(${e.blur / 3}px)` : undefined
                                    }} />
                                    <div style={{
                                        position: "absolute", inset: 0, opacity: e.fade / 100,
                                        background: `linear-gradient(to bottom, transparent ${e.inicio}%, #313338 90%)`
                                    }} />
                                </div>
                            ) : <span style={{ opacity: .4 }}>{e ? "carregando..." : "sem fundo"}</span>}
                            {e && (
                                <div style={{ display: "flex", gap: 6 }}>
                                    <button style={{ ...estiloBtn, background: "#4e5058" }} title="Copia escurecimento, desfoque e degradê deste canal para todos os outros"
                                        onClick={() => aplicarATodos(c.id)}>Copiar estilo p/ todos</button>
                                    <button style={{ ...estiloBtn, background: "#da373c" }} onClick={() => remover(c.id)}>Remover</button>
                                </div>
                            )}
                        </div>
                        {e && (
                            <div style={grade}>
                                <Ajuste rotulo="Escurecimento" min={0} max={0.9} step={0.05} valor={e.dim} onChange={v => mudar(c.id, { dim: v })} />
                                <Ajuste rotulo="Desfoque" min={0} max={12} step={1} valor={e.blur} onChange={v => mudar(c.id, { blur: v })} />
                                <Ajuste rotulo="Zoom" min={1} max={3} step={0.05} valor={e.zoom} onChange={v => mudar(c.id, { zoom: v })} />
                                <Ajuste rotulo="Degradê (força)" min={0} max={100} step={5} valor={e.fade} onChange={v => mudar(c.id, { fade: v })} />
                                <Ajuste rotulo="Horizontal" min={0} max={100} step={1} valor={e.x} onChange={v => mudar(c.id, { x: v })} />
                                <Ajuste rotulo="Vertical" min={0} max={100} step={1} valor={e.y} onChange={v => mudar(c.id, { y: v })} />
                                <Ajuste rotulo="Início do degradê (%)" min={0} max={80} step={5} valor={e.inicio} onChange={v => mudar(c.id, { inicio: v })} />
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}

function PainelJogador() {
    const { jogador, local } = settings.use(["jogador", "local"]);
    const J = lerJogador();
    void jogador;
    void local;

    const comFundo = Object.keysmapaTotal();

    function alternarCanal(id: string, mostrar: boolean) {
        const set = new Set(J.ocultos);
        if (mostrar) set.delete(id); else set.add(id);
        gravarJogador({ ocultos: [...set] });
    }

    return (
        <div style={{ marginTop: 24 }}>
            <h3 style={{ margin: "8px 0" }}>Meus ajustes (só para você)</h3>
            <p style={{ opacity: .7, fontSize: 13 }}>
                Isso não muda o que os outros jogadores veem. Atalho para ligar/desligar os fundos: <b>Ctrl+Alt+B</b>.
            </p>

            <label style={{ display: "flex", gap: 8, alignItems: "center", margin: "8px 0" }}>
                <input type="checkbox" checked={J.ativo} onChange={ev => gravarJogador({ ativo: ev.target.checked })} />
                Fundos ativados
            </label>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, margin: "12px 0" }}>
                <Ajuste rotulo="Opacidade da imagem (%)" min={0} max={100} step={5} valor={J.opacidade} onChange={v => gravarJogador({ opacidade: v })} />
                <Ajuste rotulo="Desfoque extra" min={0} max={12} step={1} valor={J.desfoque} onChange={v => gravarJogador({ desfoque: v })} />
                <Ajuste rotulo="Escurecimento extra" min={0} max={0.5} step={0.05} valor={J.escurecimento} onChange={v => gravarJogador({ escurecimento: v })} />
            </div>

            <label style={{ display: "flex", gap: 8, alignItems: "center", margin: "8px 0" }}>
                Degradê:
                <select value={J.degrade} onChange={ev => gravarJogador({ degrade: ev.target.value as Jogador["degrade"] })}
                    style={{ padding: 6, background: "#1e1f22", color: "#fff", borderRadius: 4 }}>
                    <option value="mestre">Como o mestre definiu</option>
                    <option value="cheio">Sempre completo (imagem some até a barra de digitação)</option>
                    <option value="off">Desligado (imagem em toda a área)</option>
                </select>
            </label>

            <label style={{ display: "flex", gap: 8, alignItems: "center", margin: "8px 0" }}>
                <input type="checkbox" checked={J.sombra} onChange={ev => gravarJogador({ sombra: ev.target.checked })} />
                Sombra atrás do texto (ajuda a ler)
            </label>

            <div style={{ margin: "12px 0", maxWidth: 380 }}>
                <Ajuste rotulo="Transição ao trocar de canal (ms, 0 = desligada)" min={0} max={1500} step={100}
                    valor={J.transicao} onChange={v => gravarJogador({ transicao: v })} />
            </div>

            <label style={{ display: "flex", gap: 8, alignItems: "center", margin: "8px 0" }}>
                <input type="checkbox" checked={J.congelarGif} onChange={ev => gravarJogador({ congelarGif: ev.target.checked })} />
                Pausar GIFs (mostra só o primeiro quadro)
            </label>

            {comFundo.length > 0 && (
                <div style={{ marginTop: 12 }}>
                    <b>Canais com fundo</b>
                    {comFundo.map(id => (
                        <label key={id} style={{ display: "flex", gap: 8, alignItems: "center", margin: "4px 0" }}>
                            <input type="checkbox" checked={!J.ocultos.includes(id)} onChange={ev => alternarCanal(id, ev.target.checked)} />
                            # {ChannelStore.getChannel(id)?.name ?? id}
                        </label>
                    ))}
                </div>
            )}

            <button style={{ ...estiloBtn, background: "#4e5058", marginTop: 12 }}
                onClick={() => { settings.store.jogador = "{}"; aplicar(); }}>
                Restaurar padrão
            </button>
        </div>
    );
}

function BannerAtualizacao() {
    const [estado, setEstado] = React.useState<"verificando" | "atual" | "disponivel" | "atualizando" | "pronto" | "erro">("verificando");
    const [msg, setMsg] = React.useState("");
    const args = () => ({ repo: settings.store.repo, branch: settings.store.branch });

    React.useEffect(() => {
        Native.verificarAtualizacao(args())
            .then(r => setEstado(r.disponivel ? "disponivel" : "atual"))
            .catch(() => setEstado("atual"));
    }, []);

    async function atualizarAgora() {
        setEstado("atualizando");
        try {
            await Native.atualizar(args());
            setEstado("pronto");
        } catch (e: any) {
            setMsg(String(e?.message ?? e));
            setEstado("erro");
        }
    }

    const caixa: React.CSSProperties = { padding: 12, borderRadius: 6, margin: "8px 0", background: "rgba(88,101,242,.15)" };
    if (estado === "disponivel")
        return <div style={caixa}>Há uma atualização do plugin. <button style={{ ...estiloBtn, marginLeft: 8 }} onClick={atualizarAgora}>Atualizar agora</button></div>;
    if (estado === "atualizando")
        return <div style={caixa}>Atualizando... pode levar um ou dois minutos. Não feche o Discord.</div>;
    if (estado === "pronto")
        return <div style={caixa}>Atualizado! Aperte <b>Ctrl+R</b>. Se algo parecer errado, feche o Discord por completo (inclusive pelo ícone perto do relógio) e abra de novo.</div>;
    if (estado === "erro")
        return <div style={{ ...caixa, background: "rgba(218,55,60,.2)" }}>Não consegui atualizar: {msg}<br />Seus arquivos antigos foram mantidos. Se persistir, rode o Instalar-RPG.bat.</div>;
    return null;
}

function Painel() {
    settings.use(["token"]);
    const mestre = !!settings.store.token;
    return (
        <div style={{ color: "var(--text-normal)" }}>
            <BannerAtualizacao />
            {mestre
                ? <PainelMestre />
                : <p style={{ color: "#faa61a" }}>
                    Para publicar fundos, cole seu token do GitHub no campo "token" acima (só o mestre precisa). Jogadores usam apenas "Meus ajustes".
                </p>}
            <PainelJogador />
        </div>
    );
}

// ---------- acesso rápido ----------

const Icone = ({ width = 20, height = 20, className }: { width?: number; height?: number; className?: string; }) => (
    <svg width={width} height={height} viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
        <path fillRule="evenodd" d="M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm0 2v10l4-4 3 3 4-5 4 5V5H5Zm4.5 1.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Z" />
    </svg>
);

function abrirPainel() {
    openModal(props => (
        <ModalRoot {...props} size={ModalSize.LARGE}>
            <ModalHeader>
                <h2 style={{ margin: 0, flex: 1, color: "var(--header-primary)" }}>Fundos do RPG</h2>
                <ModalCloseButton onClick={props.onClose} />
            </ModalHeader>
            <ModalContent>
                <div style={{ padding: 16 }}><Painel /></div>
            </ModalContent>
        </ModalRoot>
    ));
}

const BotaoChat = () => (
    <ChatBarButton tooltip="Fundos do RPG" onClick={abrirPainel}>
        <Icone />
    </ChatBarButton>
);

async function checarAtualizacao() {
    try {
        const args = { repo: settings.store.repo, branch: settings.store.branch };
        const r = await Native.verificarAtualizacao(args);
        if (!r.disponivel) return;
        if (settings.store.autoAtualizar) {
            await Native.atualizar(args);
            showNotification({ title: "RPG Fundos atualizado", body: "Aperte Ctrl+R para carregar a nova versão.", noPersist: true });
        } else {
            showNotification({
                title: "RPG Fundos: atualização disponível",
                body: "Clique aqui para atualizar.",
                permanent: true, noPersist: true,
                onClick: abrirPainel
            });
        }
    } catch (e) {
        console.warn("[RPGFundos] verificação de atualização falhou:", e);
    }
}

// ---------- plugin ----------

export default definePlugin({
    name: "RPGFundos",
    description: "Fundo de imagem diferente em cada canal, sincronizado com o mestre do RPG.",
    authors: [{ name: "Mestre", id: 0n }],
    settings,

    chatBarButton: { icon: Icone, render: BotaoChat },

    start() {
        styleEl = document.createElement("style");
        styleEl.id = "rpg-fundos";
        document.head.appendChild(styleEl);
        imgStyleEl = document.createElement("style");
        imgStyleEl.id = "rpg-fundos-img";
        document.head.appendChild(imgStyleEl);
        FluxDispatcher.subscribe("CHANNEL_SELECT", aoTrocarCanal);
        document.addEventListener("keydown", atalho);
        baixarRemoto();
        timer = setInterval(baixarRemoto, Math.max(15, settings.store.intervalo || 60) * 1000);
        aplicar();
        setTimeout(checarAtualizacao, 8000);
    },

    stop() {
        FluxDispatcher.unsubscribe("CHANNEL_SELECT", aoTrocarCanal);
        document.removeEventListener("keydown", atalho);
        if (timer) clearInterval(timer);
        limpar();
        styleEl?.remove();
        imgStyleEl?.remove();
        styleEl = undefined;
        imgStyleEl = undefined;
    }
});
