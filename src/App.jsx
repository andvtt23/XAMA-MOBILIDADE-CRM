
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import {
  automaticCommission,
  allocateCommissionCents,
  calculateWeeklyRideTotals,
  fingerprintFile,
  fingerprintRide,
  identifyDriverForConversation,
  identifyDriversInExport,
  filterBulkApprovableReviews,
  parseWhatsAppMessages,
  extractWhatsAppBatch,
  createWeeklyDriverCalculation,
} from "./whatsappImport.js";
import {
  analyzeWhatsAppExport,
  analyzeWhatsAppExportLocally,
} from "./whatsappAI.js";
import {
  mergeInitialDrivers,
  normalizeDriverName,
  sortDriversAlphabetically,
} from "./driverSetup.js";
import XamaLayout from "./XamaLayout.jsx";
import { calculateDriverPeriodTotals } from "./driverPeriod.js";

const STORAGE_KEYS = {
  motoristas: "xama.crm.motoristas",
  motoristasInicializados: "xama.crm.motoristas.inicializados.v1",
  resumoInicio: "xama.crm.resumo.periodo.inicio",
  resumoFim: "xama.crm.resumo.periodo.fim",
  corridas: "xama.crm.corridas",
  pagamentos: "xama.crm.pagamentos",
  transacoes: "xama.crm.transacoes",
  importacoes: "xama.crm.importacoes",
  corridasImportadas: "xama.crm.corridasImportadas",
  revisoesImportacao: "xama.crm.revisoesImportacao",
  vinculosWhatsApp: "xama.crm.vinculosWhatsApp",
  fechamentos: "xama.crm.fechamentos",
};

const STORAGE_DEFAULTS = {
  [STORAGE_KEYS.motoristas]: [],
  [STORAGE_KEYS.motoristasInicializados]: false,
  [STORAGE_KEYS.resumoInicio]: "",
  [STORAGE_KEYS.resumoFim]: "",
  [STORAGE_KEYS.corridas]: [],
  [STORAGE_KEYS.pagamentos]: [],
  [STORAGE_KEYS.transacoes]: [],
  [STORAGE_KEYS.importacoes]: [],
  [STORAGE_KEYS.corridasImportadas]: [],
  [STORAGE_KEYS.revisoesImportacao]: [],
  [STORAGE_KEYS.vinculosWhatsApp]: [],
  [STORAGE_KEYS.fechamentos]: [],
};

function readWorkspaceSnapshot() {
  return Object.fromEntries(Object.entries(STORAGE_DEFAULTS).map(([key, fallback]) => [
    key,
    readStoredState(key, fallback),
  ]));
}

function writeWorkspaceSnapshot(snapshot) {
  for (const key of Object.keys(STORAGE_DEFAULTS)) {
    if (!(key in snapshot)) throw new Error(`O conjunto ${key} não veio do banco.`);
    localStorage.setItem(key, JSON.stringify(snapshot[key]));
  }
}

function hasLocalBusinessData(snapshot) {
  return [
    STORAGE_KEYS.motoristas,
    STORAGE_KEYS.corridas,
    STORAGE_KEYS.pagamentos,
    STORAGE_KEYS.transacoes,
    STORAGE_KEYS.importacoes,
    STORAGE_KEYS.corridasImportadas,
    STORAGE_KEYS.revisoesImportacao,
    STORAGE_KEYS.fechamentos,
  ].some(key => Array.isArray(snapshot[key]) && snapshot[key].length > 0);
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => (
      `${JSON.stringify(key)}:${stableStringify(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function downloadWorkspaceBackup(snapshot) {
  const blob = new Blob([JSON.stringify({
    exportedAt: new Date().toISOString(),
    workspace: snapshot,
  }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `xama-backup-local-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function readStoredState(chave, fallback) {
  try {
    const valor = localStorage.getItem(chave);
    return valor ? JSON.parse(valor) : fallback;
  } catch {
    return fallback;
  }
}

function loadImportReviews() {
  const reviews = readStoredState(STORAGE_KEYS.revisoesImportacao, []);
  return reviews.map(review => {
    const systemMessage = String(review.sender ?? "") === "Sistema"
      || /^message:\d{1,2}:\d{2}:sistema:/i.test(String(review.identity ?? ""));
    return systemMessage
      ? {
        ...review,
        classification: "sistema",
        reviewReason: "Mensagem automática do WhatsApp; não representa uma corrida.",
        driverIdRevisao: "",
        valorRevisao: "",
      }
      : review;
  });
}

function normalizarLista(valor) {
  if (Array.isArray(valor)) {
    return valor
      .map(item => (item == null ? "" : String(item).trim()))
      .filter(item => item.length > 0);
  }

  if (typeof valor === "string") {
    return valor
      .split(/[;,\n]/)
      .map(item => item.trim())
      .filter(item => item.length > 0);
  }

  return [];
}

function rideAmountInCents(ride) {
  if (typeof ride.amountCents === "number") return ride.amountCents;
  if (typeof ride.valorCentavos === "number") return ride.valorCentavos;
  const amount = ride.amount ?? ride.valorRevisao ?? ride.valor;
  return amount == null || amount === "" ? null : Math.round(Number(amount) * 100);
}

function normalizeRideContextText(text) {
  return String(text ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/\b(a caminho|livre|ok|okay|blz|beleza|certo)\b/g, " ")
    .replace(/[^\p{L}\d]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getImportedDriverId(record) {
  return record.driverId ?? record.motoristaId ?? record.driverIdRevisao ?? "";
}

function summarizeImportWeek(rides, drivers, payments, start, end) {
  return drivers.map(driver => {
    const totals = calculateWeeklyRideTotals(rides, driver, start, end);
    const revenue = totals.revenueCents / 100;
    const commissionDue = totals.commissionCents / 100;
    const rate = totals.rate;
    const paid = payments
      .filter(payment => (
        payment.status === "confirmado"
        && payment.motoristaId === driver.id
        && payment.data >= start
        && payment.data <= end
      ))
      .reduce((sum, payment) => sum + payment.valor, 0);

    return {
      driver,
      count: totals.count,
      revenue,
      rate,
      commissionDue,
      baseDue: revenue - commissionDue,
      paid,
      pending: Math.max(0, commissionDue - paid),
    };
  });
}

function summarizeDriverRides(rides, driver) {
  const driverRides = rides.filter(
    ride => String(ride.motoristaId) === String(driver.id),
  );
  const revenueCents = driverRides.reduce((sum, ride) => (
    sum + Number(rideAmountInCents(ride) ?? 0)
  ), 0);
  const weeks = new Map();
  for (const ride of driverRides) {
    const weekStart = inicioDaSemana(ride.data);
    weeks.set(weekStart, [...(weeks.get(weekStart) ?? []), ride]);
  }
  const commissionCents = [...weeks.values()].reduce((sum, weekRides) => {
    const rate = automaticCommission(driver, weekRides.length);
    const weeklyRevenueCents = weekRides.reduce(
      (weekSum, ride) => weekSum + Number(rideAmountInCents(ride) ?? 0),
      0,
    );
    return sum + Math.round(weeklyRevenueCents * rate / 100);
  }, 0);
  return {
    quantidade: driverRides.length,
    faturamento: revenueCents / 100,
    comissao: commissionCents / 100,
    comissaoDaBase: (revenueCents - commissionCents) / 100,
  };
}

function loadSummaryDate(key, fallback) {
  const saved = readStoredState(key, fallback);
  return /^\d{4}-\d{2}-\d{2}$/.test(saved) ? saved : fallback;
}

function loadDrivers() {
  const savedDrivers = readStoredState(STORAGE_KEYS.motoristas, []);
  const initialSetupComplete = localStorage.getItem(STORAGE_KEYS.motoristasInicializados) === "true";
  const drivers = initialSetupComplete
    ? savedDrivers
    : mergeInitialDrivers(savedDrivers);
  if (!initialSetupComplete) {
    localStorage.setItem(STORAGE_KEYS.motoristas, JSON.stringify(drivers));
    localStorage.setItem(STORAGE_KEYS.motoristasInicializados, "true");
  }
  return sortDriversAlphabetically(drivers.map(driver => {
    const generoRegra = driver.generoRegra ?? "outro";
    const normalizedName = normalizeDriverName(driver.nome);
    const lizandra = normalizedName.startsWith("lizandra") || normalizedName.startsWith("lyzandra");
    const standardRates = generoRegra === "mulher" ? [13, 15] : [15];
    return {
      ...driver,
      generoRegra,
      periodStart: driver.periodStart ?? inicioDaSemana(dataLocalISO()),
      periodEnd: driver.periodEnd ?? deslocarDias(inicioDaSemana(dataLocalISO()), 6),
      aliases: Array.isArray(driver.aliases)
        ? driver.aliases
        : String(driver.aliases ?? "").split(/[;,\n]/).map(value => value.trim()).filter(Boolean),
      comissaoEspecial: driver.comissaoEspecial ?? (
        !lizandra && !standardRates.includes(Number(driver.comissao))
      ),
    };
  }));
}

function appendCalculationRevisions(history, drivers, rides) {
  const groups = new Map();
  for (const ride of rides) {
    const driver = drivers.find(item => String(item.id) === String(ride.driverId ?? ride.motoristaId));
    const date = ride.date ?? ride.data;
    if (!driver || !date) continue;
    const start = inicioDaSemana(date);
    const key = `${driver.id}|${start}`;
    groups.set(key, {
      driver,
      start,
      rides: [...(groups.get(key)?.rides ?? []), ride],
    });
  }

  let updated = history;
  for (const group of groups.values()) {
    const end = deslocarDias(group.start, 6);
    const groupHistory = updated.filter(item => (
      String(item.driverId) === String(group.driver.id)
      && item.start === group.start
      && item.end === end
    ));
    const latest = groupHistory.reduce(
      (best, item) => (!best || item.revision > best.revision ? item : best),
      null,
    );
    const revision = (latest?.revision ?? 0) + 1;
    const calculation = createWeeklyDriverCalculation(
      group.driver,
      group.rides,
      group.start,
      end,
      revision,
      currentIsoTimestamp(),
    );
    if (!calculation.count || (
      latest
      && latest.sourceFingerprint === calculation.sourceFingerprint
      && latest.rate === calculation.rate
    )) {
      continue;
    }
    if (updated === history) updated = [...history];
    updated.push({
      ...calculation,
      id: `${group.driver.id}-${group.start}-${revision}`,
    });
  }
  return updated;
}

function loadCalculationHistory() {
  const history = readStoredState(STORAGE_KEYS.fechamentos, []);
  const drivers = loadDrivers();
  const rides = [
    ...readStoredState(STORAGE_KEYS.corridas, []),
    ...readStoredState(STORAGE_KEYS.corridasImportadas, []),
  ];
  return appendCalculationRevisions(Array.isArray(history) ? history : [], drivers, rides);
}

function dataLocalISO(data = new Date()) {
  const ano = data.getFullYear();
  const mes = String(data.getMonth() + 1).padStart(2, "0");
  const dia = String(data.getDate()).padStart(2, "0");
  return `${ano}-${mes}-${dia}`;
}

function dataDeISO(valor) {
  const [ano, mes, dia] = valor.split("-").map(Number);
  return new Date(ano, mes - 1, dia, 12);
}

function deslocarDias(valor, quantidade) {
  const data = dataDeISO(valor);
  data.setDate(data.getDate() + quantidade);
  return dataLocalISO(data);
}

function inicioDaSemana(valor) {
  const diaDaSemana = dataDeISO(valor).getDay();
  return deslocarDias(valor, diaDaSemana === 0 ? -6 : 1 - diaDaSemana);
}

function formatarData(valor, opcoes = { day: "2-digit", month: "2-digit", year: "numeric" }) {
  return dataDeISO(valor).toLocaleDateString("pt-BR", opcoes);
}

function formatarValorCompacto(valor) {
  return valor.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
    notation: "compact",
    maximumFractionDigits: 1,
  });
}

function dinheiroComPrefixo(valor) {
  return Number(valor || 0).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

function currentTimestamp() {
  return Date.now();
}

function currentIsoTimestamp() {
  return new Date().toISOString();
}

function GraficoSemanal({ dias, dinheiro }) {
  const largura = 720;
  const altura = 276;
  const margem = { topo: 34, direita: 68, inferior: 46, esquerda: 68 };
  const areaLargura = largura - margem.esquerda - margem.direita;
  const areaAltura = altura - margem.topo - margem.inferior;
  const maiorFaturamento = Math.max(...dias.map(dia => dia.faturamento), 1);
  const maiorComissao = Math.max(...dias.map(dia => dia.comissao), 1);
  const pontos = dias.map((dia, indice) => ({
    ...dia,
    x: margem.esquerda + (areaLargura / (dias.length - 1)) * indice,
    yFaturamento:
      margem.topo + areaAltura - (dia.faturamento / maiorFaturamento) * areaAltura,
    yComissao:
      margem.topo + areaAltura - (dia.comissao / maiorComissao) * areaAltura,
  }));
  const caminho = chave =>
    pontos.map((ponto, indice) => `${indice === 0 ? "M" : "L"} ${ponto.x} ${ponto[chave]}`).join(" ");

  return (
    <div className="grafico-wrap">
      <div className="legenda-grafico" aria-hidden="true">
        <span><i className="legenda-faturamento" />Faturamento</span>
        <span><i className="legenda-comissao" />Comissões</span>
      </div>
      <svg
        className="grafico"
        viewBox={`0 0 ${largura} ${altura}`}
        role="img"
        aria-labelledby="grafico-titulo grafico-descricao"
      >
        <title id="grafico-titulo">Faturamento e comissões por dia</title>
        <desc id="grafico-descricao">
          Comparação diária de faturamento e comissões no fechamento semanal selecionado.
        </desc>
        {[0, 0.5, 1].map(proporcao => {
          const y = margem.topo + areaAltura * (1 - proporcao);
          return (
            <g key={proporcao}>
              <line
                x1={margem.esquerda}
                x2={largura - margem.direita}
                y1={y}
                y2={y}
                className="linha-grade"
              />
              <text x={margem.esquerda - 10} y={y + 4} textAnchor="end" className="rotulo-eixo">
                {formatarValorCompacto(maiorFaturamento * proporcao)}
              </text>
              <text x={largura - margem.direita + 10} y={y + 4} className="rotulo-eixo">
                {formatarValorCompacto(maiorComissao * proporcao)}
              </text>
            </g>
          );
        })}
        <path d={caminho("yFaturamento")} className="linha-dados linha-dados-faturamento" />
        <path d={caminho("yComissao")} className="linha-dados linha-dados-comissao" />
        {pontos.map(ponto => (
          <g key={ponto.data}>
            <circle
              cx={ponto.x}
              cy={ponto.yFaturamento}
              r="4.5"
              className="ponto-faturamento"
            >
              <title>{`${ponto.nome}: ${dinheiro(ponto.faturamento)} em faturamento`}</title>
            </circle>
            <circle cx={ponto.x} cy={ponto.yComissao} r="4.5" className="ponto-comissao">
              <title>{`${ponto.nome}: ${dinheiro(ponto.comissao)} em comissões`}</title>
            </circle>
            <text
              x={ponto.x}
              y={altura - 16}
              textAnchor="middle"
              className="rotulo-dia"
            >
              {ponto.nome}
            </text>
          </g>
        ))}
      </svg>
      <p className="nota-grafico">
        Escalas independentes para faturamento (esquerda) e comissões (direita).
      </p>
    </div>
  );
}

export default function App() {
  const [phase, setPhase] = useState("checking");
  const [user, setUser] = useState(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [workspaceError, setWorkspaceError] = useState("");
  const [localConflict, setLocalConflict] = useState(null);
  const [workspaceSnapshot, setWorkspaceSnapshot] = useState(null);
  const [workspaceVersion, setWorkspaceVersion] = useState(0);
  const syncState = useRef({ version: 0, pending: null, saving: false, blocked: false });

  async function getJson(url, options = {}) {
    const response = await fetch(url, options);
    let payload;
    try {
      payload = await response.json();
    } catch {
      const error = new Error(`O servidor respondeu HTTP ${response.status} sem JSON válido.`);
      error.status = response.status;
      throw error;
    }
    if (!response.ok) {
      const error = new Error(payload.error || `HTTP ${response.status}`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  function applyRemoteWorkspace(snapshot, version, currentUser) {
    try {
      writeWorkspaceSnapshot(snapshot);
    } catch (error) {
      setAuthError(`Não foi possível aplicar os dados do servidor no navegador: ${error.message}`);
      setPhase("error");
      return;
    }
    syncState.current = { version, pending: null, saving: false, blocked: false };
    setWorkspaceSnapshot(snapshot);
    setWorkspaceVersion(version);
    setWorkspaceError("");
    setLocalConflict(null);
    setUser(currentUser);
    setPhase("ready");
  }

  async function hydrateWorkspace(currentUser) {
    setPhase("loading-workspace");
    const localSnapshot = readWorkspaceSnapshot();
    let remote = await getJson("/api/state");
    if (!remote.state) {
      try {
        remote = await getJson("/api/state", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ state: localSnapshot, expectedVersion: 0 }),
        });
      } catch (error) {
        if (error.status !== 409) throw error;
        remote = await getJson("/api/state");
      }
    } else if (
      hasLocalBusinessData(localSnapshot)
      && stableStringify(localSnapshot) !== stableStringify(remote.state)
    ) {
      setLocalConflict({ localSnapshot, remote, user: currentUser });
      setUser(currentUser);
      setPhase("migration-review");
      return;
    }
    if (!remote.state) throw new Error("O servidor não retornou um estado persistido.");
    applyRemoteWorkspace(remote.state, remote.version, currentUser);
  }

  useEffect(() => {
    let active = true;
    getJson("/api/auth/me")
      .then(async session => {
        if (!active) return;
        if (session.mode === "local") {
          setPhase("local");
          return;
        }
        if (!session.user) {
          setPhase("login");
          return;
        }
        await hydrateWorkspace(session.user);
      })
      .catch(error => {
        if (active) {
          setAuthError(`Não foi possível carregar a sessão: ${error.message}`);
          setPhase("error");
        }
      });
    return () => {
      active = false;
    };
  }, []);

  async function entrar(event) {
    event.preventDefault();
    setAuthError("");
    setPhase("signing-in");
    try {
      const session = await getJson("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      await hydrateWorkspace(session.user);
      setPassword("");
    } catch (error) {
      setAuthError(error.message);
      setPhase("login");
    }
  }

  const saveWorkspace = useCallback(snapshot => {
    const sync = syncState.current;
    if (sync.blocked) return;
    sync.pending = snapshot;
    if (sync.saving) return;
    sync.saving = true;
    void (async () => {
      while (sync.pending && !sync.blocked) {
        const pending = sync.pending;
        sync.pending = null;
        try {
          const result = await getJson("/api/state", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ state: pending, expectedVersion: sync.version }),
          });
          sync.version = result.version;
          setWorkspaceError("");
        } catch (error) {
          sync.blocked = true;
          if (error.status === 409 && error.payload?.state) {
            setLocalConflict({
              localSnapshot: pending,
              remote: error.payload,
              user,
            });
          } else {
            sync.pending = pending;
          }
          setWorkspaceError(error.message);
        }
      }
      sync.saving = false;
    })();
  }, [user]);

  const retryWorkspaceSync = useCallback(() => {
    const sync = syncState.current;
    if (sync.saving) return;
    sync.blocked = false;
    saveWorkspace(sync.pending ?? readWorkspaceSnapshot());
  }, [saveWorkspace]);

  async function encerrarSessao() {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      syncState.current = { version: 0, pending: null, saving: false, blocked: false };
      setUser(null);
      setWorkspaceError("");
      setPhase("login");
    }
  }

  async function aceitarDadosDoServidor() {
    if (!localConflict) return;
    downloadWorkspaceBackup(localConflict.localSnapshot);
    applyRemoteWorkspace(
      localConflict.remote.state,
      localConflict.remote.version,
      localConflict.user,
    );
  }

  if (phase === "local" || phase === "ready") {
    return (
      <CRMApplication
        key={phase === "ready" ? `${user?.id}:${workspaceVersion}` : "local"}
        user={phase === "ready" ? user : null}
        onLogout={encerrarSessao}
        onSaveWorkspace={phase === "ready" ? saveWorkspace : null}
        workspaceError={workspaceError}
        onReloadWorkspace={phase === "ready" && localConflict ? aceitarDadosDoServidor : null}
        onRetrySync={phase === "ready" ? retryWorkspaceSync : null}
        initialWorkspaceSnapshot={workspaceSnapshot}
      />
    );
  }

  if (phase === "checking" || phase === "signing-in" || phase === "loading-workspace") {
    return (
      <main className="xama-auth-shell" aria-live="polite">
        <section className="xama-auth-card">
          <span className="marca-simbolo" aria-hidden="true">X</span>
          <h1>Xama Mobilidade</h1>
          <p>{phase === "checking" ? "Verificando sessão segura…" : "Carregando os dados persistidos…"}</p>
        </section>
      </main>
    );
  }

  if (phase === "migration-review" && localConflict) {
    return (
      <main className="xama-auth-shell">
        <section className="xama-auth-card" aria-labelledby="xama-migration-title">
          <span className="marca-simbolo" aria-hidden="true">X</span>
          <h1 id="xama-migration-title">Dados locais encontrados</h1>
          <p>
            Este navegador contém dados diferentes dos dados compartilhados no banco.
            Antes de continuar, baixe uma cópia local. Nenhum dado local foi apagado.
          </p>
          <button type="button" onClick={aceitarDadosDoServidor}>
            Baixar backup local e abrir dados compartilhados
          </button>
          <button type="button" className="botao-secundario" onClick={encerrarSessao}>
            Sair sem substituir os dados deste navegador
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="xama-auth-shell">
      <section className="xama-auth-card" aria-labelledby="xama-login-title">
        <span className="marca-simbolo" aria-hidden="true">X</span>
        <h1 id="xama-login-title">Xama Mobilidade</h1>
        <p>Entre para acessar os fechamentos e os cadastros da empresa.</p>
        {authError && <p className="xama-auth-error" role="alert">{authError}</p>}
        <form onSubmit={entrar}>
          <label>
            E-mail
            <input
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={event => setEmail(event.target.value)}
            />
          </label>
          <label>
            Senha
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={event => setPassword(event.target.value)}
            />
          </label>
          <button type="submit">Entrar</button>
        </form>
      </section>
    </main>
  );
}

function CRMApplication({
  user,
  onLogout,
  onSaveWorkspace,
  workspaceError,
  onReloadWorkspace,
  onRetrySync,
  initialWorkspaceSnapshot,
}) {
  const hoje = dataLocalISO();
  const exibirSecoesFinanceirasOcultas = false;
  const [relatoriosAbertos, setRelatoriosAbertos] = useState(false);
  const [motoristas, setMotoristas] = useState(loadDrivers);
  const [corridas, setCorridas] = useState(() => readStoredState(STORAGE_KEYS.corridas, []));
  const [pagamentos, setPagamentos] = useState(() => readStoredState(STORAGE_KEYS.pagamentos, []));
  const [transacoes, setTransacoes] = useState(() => readStoredState(STORAGE_KEYS.transacoes, []));
  const [importacoes, setImportacoes] = useState(() => readStoredState(STORAGE_KEYS.importacoes, []));
  const [corridasImportadas, setCorridasImportadas] = useState(() => readStoredState(STORAGE_KEYS.corridasImportadas, []));
  const [revisoesImportacao, setRevisoesImportacao] = useState(loadImportReviews);
  const [vinculosWhatsApp, setVinculosWhatsApp] = useState(() => readStoredState(STORAGE_KEYS.vinculosWhatsApp, []));
  const [fechamentos, setFechamentos] = useState(loadCalculationHistory);
  const [preImportacao, setPreImportacao] = useState(null);
  const [aiStatus, setAiStatus] = useState({
    loading: true,
    ready: false,
    connected: false,
    missing: [],
    error: "",
    manualFallback: false,
  });
  const [mensagensImportacaoMotoristas, setMensagensImportacaoMotoristas] = useState({});
  const [nome, setNome] = useState("");
  const [percentual, setPercentual] = useState("15");
  const [modoComissaoNovo, setModoComissaoNovo] = useState("automatica");
  const [generoRegra, setGeneroRegra] = useState("outro");
  const [motoristaId, setMotoristaId] = useState(() => String(loadDrivers()[0]?.id ?? ""));
  const [valor, setValor] = useState("");
  const [data, setData] = useState(hoje);
  const [semanaInicio, setSemanaInicio] = useState(() => inicioDaSemana(hoje));
  const [resumoInicio, setResumoInicio] = useState(() => loadSummaryDate(
    STORAGE_KEYS.resumoInicio,
    inicioDaSemana(hoje),
  ));
  const [resumoFim, setResumoFim] = useState(() => loadSummaryDate(
    STORAGE_KEYS.resumoFim,
    deslocarDias(inicioDaSemana(hoje), 6),
  ));
  const [abaAtiva, setAbaAtiva] = useState("operacao");
  const [filtroMotoristaRelatorio, setFiltroMotoristaRelatorio] = useState("");
  const [filtroInicioRelatorio, setFiltroInicioRelatorio] = useState("");
  const [filtroFimRelatorio, setFiltroFimRelatorio] = useState("");
  const [paginaRevisoes, setPaginaRevisoes] = useState(0);
  const [paginaRelatorio, setPaginaRelatorio] = useState(0);
  const [paginaCorridasImportadas, setPaginaCorridasImportadas] = useState(0);
  const [filtroMotoristaRevisao, setFiltroMotoristaRevisao] = useState("");
  const [filtroImportacaoRevisao, setFiltroImportacaoRevisao] = useState("");
  const [conferenciaExpandida, setConferenciaExpandida] = useState(false);
  const [mensagemImportacao, setMensagemImportacao] = useState("");
  const [processandoArquivo, setProcessandoArquivo] = useState(false);
  const [resultadoImportacao, setResultadoImportacao] = useState(null);
  const [novoPagamento, setNovoPagamento] = useState(() => ({
    motoristaId: String(loadDrivers()[0]?.id ?? ""),
    data: hoje,
    valor: "",
    status: "pendente",
  }));
  const [novaTransacao, setNovaTransacao] = useState({
    tipo: "entrada",
    data: hoje,
    valor: "",
    descricao: "",
  });
  const [novoUsuarioEmail, setNovoUsuarioEmail] = useState("");
  const [novoUsuarioPassword, setNovoUsuarioPassword] = useState("");
  const [mensagemUsuario, setMensagemUsuario] = useState("");
  const [usuariosAcesso, setUsuariosAcesso] = useState([]);
  const [senhaAtual, setSenhaAtual] = useState("");
  const [senhaNova, setSenhaNova] = useState("");
  const [mensagemSenha, setMensagemSenha] = useState("");
  const initialWorkspaceSync = useRef(stableStringify(initialWorkspaceSnapshot));

  useEffect(() => {
    let active = true;
    fetch("/api/ai/status")
      .then(async response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const status = await response.json();
        if (!status || typeof status.ready !== "boolean" || !Array.isArray(status.missing)) {
          throw new Error("Resposta de status inválida.");
        }
        if (active) setAiStatus({ ...status, loading: false, error: "" });
      })
      .catch(error => {
        if (active) {
          setAiStatus({
            loading: false,
            ready: false,
            connected: false,
            missing: [],
            error: `Não foi possível consultar a API da OpenAI: ${error.message}`,
          });
        }
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.motoristas, JSON.stringify(motoristas));
  }, [motoristas]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.resumoInicio, JSON.stringify(resumoInicio));
  }, [resumoInicio]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.resumoFim, JSON.stringify(resumoFim));
  }, [resumoFim]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.corridas, JSON.stringify(corridas));
  }, [corridas]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.pagamentos, JSON.stringify(pagamentos));
  }, [pagamentos]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.transacoes, JSON.stringify(transacoes));
  }, [transacoes]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.importacoes, JSON.stringify(importacoes));
  }, [importacoes]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.corridasImportadas, JSON.stringify(corridasImportadas));
  }, [corridasImportadas]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.revisoesImportacao, JSON.stringify(revisoesImportacao));
  }, [revisoesImportacao]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.vinculosWhatsApp, JSON.stringify(vinculosWhatsApp));
  }, [vinculosWhatsApp]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.fechamentos, JSON.stringify(fechamentos));
  }, [fechamentos]);

  useEffect(() => {
    if (!user || !onSaveWorkspace) return undefined;
    if (!initialWorkspaceSync.current) {
      initialWorkspaceSync.current = true;
      return undefined;
    }
    const snapshot = {
      [STORAGE_KEYS.motoristas]: motoristas,
      [STORAGE_KEYS.motoristasInicializados]: true,
      [STORAGE_KEYS.resumoInicio]: resumoInicio,
      [STORAGE_KEYS.resumoFim]: resumoFim,
      [STORAGE_KEYS.corridas]: corridas,
      [STORAGE_KEYS.pagamentos]: pagamentos,
      [STORAGE_KEYS.transacoes]: transacoes,
      [STORAGE_KEYS.importacoes]: importacoes,
      [STORAGE_KEYS.corridasImportadas]: corridasImportadas,
      [STORAGE_KEYS.revisoesImportacao]: revisoesImportacao,
      [STORAGE_KEYS.vinculosWhatsApp]: vinculosWhatsApp,
      [STORAGE_KEYS.fechamentos]: fechamentos,
    };
    const serialized = stableStringify(snapshot);
    if (initialWorkspaceSync.current !== null) {
      const changedDuringInitialization = initialWorkspaceSync.current !== serialized;
      initialWorkspaceSync.current = null;
      if (!changedDuringInitialization) return undefined;
    }
    const timer = window.setTimeout(() => onSaveWorkspace(snapshot), 500);
    return () => window.clearTimeout(timer);
  }, [
    user,
    onSaveWorkspace,
    motoristas,
    resumoInicio,
    resumoFim,
    corridas,
    pagamentos,
    transacoes,
    importacoes,
    corridasImportadas,
    revisoesImportacao,
    vinculosWhatsApp,
    fechamentos,
  ]);

  async function criarUsuario(e) {
    e.preventDefault();
    setMensagemUsuario("Criando conta…");
    try {
      const response = await fetch("/api/auth/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: novoUsuarioEmail, password: novoUsuarioPassword }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      setMensagemUsuario(`Conta criada para ${payload.user.email}.`);
      setNovoUsuarioEmail("");
      setNovoUsuarioPassword("");
      await carregarUsuarios();
    } catch (error) {
      setMensagemUsuario(`Não foi possível criar a conta: ${error.message}`);
    }
  }

  async function carregarUsuarios() {
    try {
      const response = await fetch("/api/auth/users");
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      setUsuariosAcesso(payload.users);
    } catch (error) {
      setMensagemUsuario(`Não foi possível carregar contas: ${error.message}`);
    }
  }

  async function alterarStatusUsuario(account) {
    try {
      const response = await fetch(`/api/auth/users/${encodeURIComponent(account.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !account.active }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      await carregarUsuarios();
    } catch (error) {
      setMensagemUsuario(`Não foi possível alterar a conta: ${error.message}`);
    }
  }

  async function alterarSenhaDaConta(event) {
    event.preventDefault();
    setMensagemSenha("Atualizando senha…");
    try {
      const response = await fetch("/api/auth/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: senhaAtual, newPassword: senhaNova }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      setSenhaAtual("");
      setSenhaNova("");
      setMensagemSenha("Senha atualizada. As outras sessões desta conta foram encerradas.");
    } catch (error) {
      setMensagemSenha(`Não foi possível alterar a senha: ${error.message}`);
    }
  }

  function adicionarMotorista(e) {
    e.preventDefault();
    const nomeFormatado = nome.trim();
    const percentualNumerico = Number(percentual);

    if (!nomeFormatado || !Number.isFinite(percentualNumerico) || percentualNumerico < 0 || percentualNumerico > 100) {
      return;
    }

    const novoMotorista = {
      id: currentTimestamp(),
      nome: nomeFormatado,
      comissao: percentualNumerico,
      comissaoEspecial: modoComissaoNovo === "especial",
      generoRegra,
      periodStart: resumoInicio,
      periodEnd: resumoFim,
    };
    if (motoristas.length === 0) {
      setMotoristaId(String(novoMotorista.id));
      setNovoPagamento(prev => ({ ...prev, motoristaId: String(novoMotorista.id) }));
    }
    setMotoristas(prev => sortDriversAlphabetically([...prev, novoMotorista]));
    setNome("");
    setPercentual("15");
    setModoComissaoNovo("automatica");
  }

  function salvarNomeMotorista(motoristaIdAtual, nomeDigitado) {
    const motoristaAtual = motoristas.find(item => item.id === motoristaIdAtual);
    const nomeAtualizado = String(nomeDigitado ?? motoristaAtual?.nome ?? "").trim();
    if (!nomeAtualizado) {
      return;
    }
    setMotoristas(previous => sortDriversAlphabetically(previous.map(motorista => (
      motorista.id === motoristaIdAtual
        ? { ...motorista, nome: nomeAtualizado }
        : motorista
    ))));
  }

  function excluirMotorista(motoristaIdAtual) {
    const motorista = motoristas.find(item => String(item.id) === String(motoristaIdAtual));
    if (!motorista || !window.confirm(
      `Excluir somente o cadastro de ${motorista.nome}? Corridas e históricos existentes serão preservados.`,
    )) {
      return;
    }
    const nextDrivers = motoristas.filter(
      item => String(item.id) !== String(motoristaIdAtual),
    );
    setMotoristas(nextDrivers);
    const nextDriverId = String(nextDrivers[0]?.id ?? "");
    setMotoristaId(previous => (
      String(previous) === String(motoristaIdAtual) ? nextDriverId : previous
    ));
    setNovoPagamento(previous => (
      String(previous.motoristaId) === String(motoristaIdAtual)
        ? { ...previous, motoristaId: nextDriverId }
        : previous
    ));
  }

  function alterarComissao(motoristaIdAtual, valorDigitado) {
    const valorNumerico = Number(valorDigitado);

    if (!Number.isFinite(valorNumerico) || valorNumerico < 0 || valorNumerico > 100) {
      return;
    }

    const nextDrivers = motoristas.map(motorista => (
      motorista.id === motoristaIdAtual
        ? { ...motorista, comissao: valorNumerico, comissaoEspecial: true }
        : motorista
    ));
    setMotoristas(nextDrivers);
    atualizarFechamentos(todasCorridas, nextDrivers);
  }

  function alterarModoComissao(motoristaIdAtual, modo) {
    const nextDrivers = motoristas.map(motorista => (
      motorista.id === motoristaIdAtual
        ? { ...motorista, comissaoEspecial: modo === "especial" }
        : motorista
    ));
    setMotoristas(nextDrivers);
    atualizarFechamentos(todasCorridas, nextDrivers);
  }

  function alterarRegraDeGenero(motoristaIdAtual, valorAtualizado) {
    const nextDrivers = motoristas.map(motorista => (
      motorista.id === motoristaIdAtual
        ? { ...motorista, generoRegra: valorAtualizado }
        : motorista
    ));
    setMotoristas(nextDrivers);
    atualizarFechamentos(todasCorridas, nextDrivers);
  }

  function alterarTelefoneMotorista(motoristaIdAtual, telefone) {
    setMotoristas(prev => prev.map(motorista => (
      motorista.id === motoristaIdAtual ? { ...motorista, telefone } : motorista
    )));
  }

  function alterarAliasesMotorista(motoristaIdAtual, texto) {
    const aliases = [...new Set(texto.split(/[;,\n]/).map(item => item.trim()).filter(Boolean))];
    setMotoristas(prev => prev.map(motorista => (
      motorista.id === motoristaIdAtual ? { ...motorista, aliases } : motorista
    )));
  }

  function alterarPeriodoMotorista(motoristaIdAtual, campo, valorAtualizado) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(valorAtualizado)) {
      return;
    }
    setMotoristas(previous => previous.map(motorista => (
      String(motorista.id) === String(motoristaIdAtual)
        ? { ...motorista, [campo]: valorAtualizado }
        : motorista
    )));
  }

  function alterarPeriodoResumo(limite, valorAtualizado) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(valorAtualizado)) {
      return;
    }
    if (limite === "start") setResumoInicio(valorAtualizado);
    if (limite === "end") setResumoFim(valorAtualizado);
  }

  function limparHistoricoImportacao() {
    const confirmado = window.confirm(
      `Limpar as corridas e o fechamento de ${formatarData(semanaInicio)} a ${formatarData(semanaFim)}? O histórico anterior e os cadastros serão preservados.`,
    );
    if (!confirmado) {
      return;
    }

    const ridesToArchive = [...corridas, ...corridasImportadas].filter(ride => {
      const date = ride.date ?? ride.data;
      return date >= semanaInicio && date <= semanaFim;
    });
    setFechamentos(previous => appendCalculationRevisions(
      previous,
      motoristas,
      ridesToArchive,
    ));
    setCorridas(prev => prev.filter(ride => (
      ride.data < semanaInicio || ride.data > semanaFim
    )));
    setCorridasImportadas(prev => prev.filter(ride => (
      ride.date < semanaInicio || ride.date > semanaFim
    )));
    setResultadoImportacao(null);
    setPreImportacao(null);
    setMensagemImportacao(
      `Fechamento de ${formatarData(semanaInicio)} a ${formatarData(semanaFim)} limpo. O histórico foi preservado; motoristas e configurações não foram alterados.`,
    );
  }

  function limparImportacaoMotorista(motoristaIdAtual) {
    const motorista = motoristas.find(
      driver => String(driver.id) === String(motoristaIdAtual),
    );
    if (!motorista) {
      setMensagemImportacao("Não foi possível localizar o cadastro do motorista para limpar a importação.");
      return;
    }

    const driverId = String(motorista.id);
    const ridesToRemove = corridasImportadas.filter(
      ride => String(getImportedDriverId(ride)) === driverId,
    );
    const reviewsToRemove = revisoesImportacao.filter(
      review => String(getImportedDriverId(review)) === driverId,
    );
    const signaturesToRemove = new Set([
      ...ridesToRemove,
      ...reviewsToRemove,
    ].map(record => record.importacaoId).filter(Boolean));
    const signaturesUsedByOtherDrivers = new Set([
      ...corridasImportadas,
      ...revisoesImportacao,
      ...importacoes,
    ].filter(record => {
      const ownerId = getImportedDriverId(record);
      return ownerId
        && String(ownerId) !== driverId
        && (record.importacaoId || record.assinatura);
    }).map(record => record.importacaoId ?? record.assinatura));
    for (const importacao of importacoes) {
      if (String(importacao.driverId ?? "") === driverId && importacao.assinatura) {
        signaturesToRemove.add(importacao.assinatura);
      }
    }
    const removableSignatures = new Set([...signaturesToRemove].filter(
      signature => !signaturesUsedByOtherDrivers.has(signature),
    ));
    const importsToRemove = importacoes.filter(importacao => (
      String(importacao.driverId ?? "") === driverId
      || removableSignatures.has(importacao.assinatura)
    ));
    if (
      ridesToRemove.length === 0
      && reviewsToRemove.length === 0
      && importsToRemove.length === 0
    ) {
      setMensagensImportacaoMotoristas(previous => ({
        ...previous,
        [driverId]: `Não há corridas, pendências ou importações para limpar de ${motorista.nome}.`,
      }));
      return;
    }

    const confirmed = window.confirm(
      `Limpar ${ridesToRemove.length} corrida(s), ${reviewsToRemove.length} item(ns) pendentes e ${importsToRemove.length} importação(ões) de ${motorista.nome}? O cadastro, a comissão, as identificações, as corridas manuais e o histórico de fechamentos serão preservados.`,
    );
    if (!confirmed) return;

    const belongsToRemovedImport = record => (
      String(getImportedDriverId(record)) === driverId
      || (record.importacaoId && removableSignatures.has(record.importacaoId))
    );

    setCorridasImportadas(previous => previous.filter(ride => !belongsToRemovedImport(ride)));
    setRevisoesImportacao(previous => previous.filter(review => !belongsToRemovedImport(review)));
    setImportacoes(previous => previous.filter(importacao => (
      !importsToRemove.includes(importacao)
    )));
    if (preImportacao?.motoristaId
      && String(preImportacao.motoristaId) === driverId) {
      setPreImportacao(null);
    }
    setResultadoImportacao(null);
    setPaginaCorridasImportadas(0);
    setMensagensImportacaoMotoristas(previous => ({
      ...previous,
      [driverId]: `Limpeza concluída para ${motorista.nome}: ${ridesToRemove.length} corrida(s) e ${reviewsToRemove.length} pendência(s) removidas. Cadastro, configurações e histórico de fechamentos preservados.`,
    }));
  }

  async function importarConversa(event, motoristaIdForcado = null) {
    const arquivos = Array.from(event.target.files ?? []);
    event.target.value = "";

    if (arquivos.length === 0) {
      return;
    }
    if (motoristaIdForcado && arquivos.length !== 1) {
      setMensagensImportacaoMotoristas(previous => ({
        ...previous,
        [motoristaIdForcado]: "Selecione um único arquivo por motorista.",
      }));
      return;
    }
    const motoristaForcado = motoristaIdForcado
      ? motoristas.find(driver => String(driver.id) === String(motoristaIdForcado))
      : null;
    if (motoristaIdForcado && !motoristaForcado) {
      throw new Error("O cadastro associado ao cartão não foi encontrado.");
    }
    if (motoristaForcado && (
      !motoristaForcado.periodStart
      || !motoristaForcado.periodEnd
      || motoristaForcado.periodStart > motoristaForcado.periodEnd
    )) {
      setMensagensImportacaoMotoristas(previous => ({
        ...previous,
        [motoristaForcado.id]: "Informe um período válido antes de importar.",
      }));
      return;
    }

    setProcessandoArquivo(true);
    if (motoristaForcado) {
      setMensagensImportacaoMotoristas(previous => ({
        ...previous,
        [motoristaForcado.id]: "Lendo e analisando arquivo…",
      }));
    } else {
      setMensagemImportacao(`${arquivos.length} arquivo(s) selecionado(s). Processando lote...`);
    }
    setResultadoImportacao(null);
    setPreImportacao(null);
    await new Promise(resolve => window.setTimeout(resolve, 0));

    const conversations = [];
    const errors = [];
    const activeImportSignatures = new Set([
      ...corridasImportadas.map(ride => ride.importacaoId),
      ...revisoesImportacao.map(review => review.importacaoId),
    ].filter(Boolean));
    const existingSignatures = new Set(importacoes
      .filter(item => activeImportSignatures.has(item.assinatura))
      .map(item => item.assinatura));
    const batchSignatures = new Set();
    const batchRideFingerprints = new Set();
    const batchTripRides = new Map();
    const existingRides = new Map([
      ...corridasImportadas.map(ride => [ride.fingerprint, ride]),
      ...revisoesImportacao.map(ride => [ride.fingerprint, ride]),
    ]);

    const extractedFiles = await extractWhatsAppBatch(
      arquivos,
      async (file, index, totalFiles) => {
        setMensagemImportacao(`Processando ${index + 1}/${totalFiles}: ${file.name}`);
        await new Promise(resolve => window.setTimeout(resolve, 0));
      },
    );
    for (const [fileIndex, extractedFile] of extractedFiles.entries()) {
      const fileName = extractedFile.fileName;
      if (extractedFile.error) {
        errors.push({ arquivo: fileName, mensagem: extractedFile.error });
        continue;
      }
      for (const textFile of extractedFile.conversations) {
          const signature = fingerprintFile(textFile.text);
          const messages = parseWhatsAppMessages(textFile.text);
          const conversationDates = messages.map(message => message.date).sort();
          const id = `${fileIndex}-${signature}`;
          const identifiedDriver = identifyDriverForConversation(
            `${fileName} ${textFile.name}`,
            messages,
            motoristas,
            vinculosWhatsApp,
          );
          const conversation = {
            id,
            arquivo: fileName,
            arquivoConversa: textFile.name,
            assinatura: signature,
            mensagensAnalisadas: messages.length,
            periodo: conversationDates.length
              ? { inicio: conversationDates[0], fim: conversationDates.at(-1) }
              : null,
            erro: "",
            motoristasIdentificados: identifyDriversInExport(textFile.text, motoristas),
            remetentes: [...new Set(messages
              .filter(message => !message.sender.toLocaleLowerCase("pt-BR").includes("xama mobilidade urbana"))
              .map(message => message.sender.trim()))],
            motorista: motoristaForcado
              ? {
                driverId: motoristaForcado.id,
                driverName: motoristaForcado.nome,
                method: "selecionado no cartão do motorista",
              }
              : identifiedDriver,
            candidatos: [],
            foraDoPeriodo: 0,
          };

                   conversation.reanalise = existingSignatures.has(signature);

          if (batchSignatures.has(signature)) {
            conversation.erro = "Conversa repetida no lote selecionado.";
            conversation.duplicada = true;
            conversations.push(conversation);
            continue;
          }

          batchSignatures.add(signature);

          if (messages.length === 0) {
            conversation.erro = "Formato de mensagem do WhatsApp não reconhecido.";
            conversations.push(conversation);
            continue;
          }

          let candidates = [];
          try {
            const driver = motoristas.find(item => (
              String(item.id) === String(conversation.motorista.driverId)
            )) ?? null;
            const analysis = await analyzeWhatsAppExport({
              text: textFile.text,
              driverName: driver?.nome
                ?? conversation.motorista.driverName
                ?? conversation.remetentes[0]
                ?? "Motorista não identificado",
              driver,
              periodStart: motoristaForcado?.periodStart ?? null,
              periodEnd: motoristaForcado?.periodEnd ?? null,
            }, {
              onProgress: progress => {
                const message = progress.totalChunks
                  ? `IA Luna: ${progress.stage === "preparing" ? "preparando" : "analisando"} parte ${progress.completedChunks}/${progress.totalChunks} · ${progress.messagesAnalyzed} mensagens do período.`
                  : `Preparando análise anonimizada de ${progress.messagesAnalyzed} mensagem(ns)…`;
                if (motoristaForcado) {
                  setMensagensImportacaoMotoristas(previous => ({
                    ...previous,
                    [motoristaForcado.id]: message,
                  }));
                } else {
                  setMensagemImportacao(message);
                }
              },
            });
            candidates = analysis.candidates;
            conversation.aiSummary = analysis.summary;
            conversation.aiUnclassified = analysis.unclassified;
            conversation.aiFareAudit =
  analysis.fareMessagesWithoutRide ?? [];
            setAiStatus(previous => ({
              ...previous,
              loading: false,
              ready: true,
              connected: true,
              error: "",
              manualFallback: false,
              model: analysis.summary.model,
             provider: "OpenAI API",
            }));
                    } catch (error) {
            const failureReason = error instanceof Error
              ? error.message
              : "Falha desconhecida ao consultar a OpenAI.";
            setAiStatus(previous => ({
              ...previous,
              loading: false,
              connected: false,
              error: failureReason,
              manualFallback: false,
            }));
            conversation.erro = `Falha na análise pela OpenAI: ${failureReason}`;
            conversations.push(conversation);
            continue;
          }
          if (conversation.analysisMode !== "manual") conversation.foraDoPeriodo = 0;
                const fingerprintsInConversation = new Set();
          for (const candidate of candidates) {
            if (
              fingerprintsInConversation.has(candidate.fingerprint)
              || batchRideFingerprints.has(candidate.fingerprint)
            ) {
              continue;
            }
            fingerprintsInConversation.add(candidate.fingerprint);
            batchRideFingerprints.add(candidate.fingerprint);

            const existing = existingRides.get(candidate.fingerprint)
              ?? (candidate.hasTripId
                ? [...corridasImportadas, ...revisoesImportacao].find(ride => (
                  ride.identity === candidate.identity
                  && ride.date === candidate.date
                  && ride.driverId === candidate.driverId
                ))
                : null);
            const tripKey = `${candidate.date}|${candidate.driverId}|${candidate.identity}`;
            const batchExisting = candidate.hasTripId ? batchTripRides.get(tripKey) : null;
            const duplicateRide = existing ?? batchExisting;

            if (duplicateRide && rideAmountInCents(duplicateRide) === candidate.amountCents) {
              continue;
            }

            let reviewReason = candidate.reviewReason;
            if (existing || batchExisting) {
              reviewReason = "Possível correção de uma corrida já registrada; conferir antes de substituir";
            }
            const possibleCollision = [...corridasImportadas, ...revisoesImportacao].some(ride => (
              ride.date === candidate.date
              && ride.driverId === candidate.driverId
              && candidate.amountCents !== null
              && rideAmountInCents(ride) === candidate.amountCents
              && !candidate.hasTripId
              && normalizeRideContextText(ride.text) !== ""
              && normalizeRideContextText(ride.text) === normalizeRideContextText(candidate.text)
            ));
            if (possibleCollision) {
              reviewReason = "Possível duplicidade sem identificador; conferir antes de contabilizar";
            }

            conversation.candidatos.push({
              ...candidate,
              id: `${id}-${conversation.candidatos.length}`,
              reviewReason,
            });
            if (candidate.hasTripId) {
              batchTripRides.set(tripKey, candidate);
            }
          }
          if (conversation.candidatos.length === 0 && !conversation.duplicada) {
            if (conversation.analysisMode === "manual") {
              conversation.aviso = "Nenhuma corrida potencial foi identificada; as mensagens originais serão preservadas no histórico.";
            } else {
              conversation.erro = "Nenhuma corrida potencial identificada; nenhuma corrida será inventada.";
            }
          }
          conversations.push(conversation);
      }
    }

    setPreImportacao({
      arquivos: arquivos.map(file => file.name),
      conversations,
      errors,
      motoristaId: motoristaForcado?.id ?? null,
    });
    const conversationCount = conversations.length;
    const candidateCount = conversations.reduce((sum, item) => sum + item.candidatos.length, 0);
    if (motoristaForcado) {
      const manualCount = conversations.filter(item => item.analysisMode === "manual").length;
      setMensagensImportacaoMotoristas(previous => ({
        ...previous,
        [motoristaForcado.id]: `Prévia pronta: ${candidateCount} item(ns) para conferência de ${motoristaForcado.nome}.${manualCount ? ` ${manualCount} conversa(s) processada(s) em modo manual; nenhum item foi confirmado automaticamente.` : ""} Nada foi salvo ainda.`,
      }));
    } else {
      setMensagemImportacao(
        `Prévia pronta: ${arquivos.length} arquivo(s), ${conversationCount} conversa(s), ${candidateCount} item(ns) para conferência; ${conversations.filter(item => item.analysisMode === "manual").length} conversa(s) em modo manual; ${errors.length} arquivo(s) com erro. Nada foi salvo ainda.`,
      );
    }
    setProcessandoArquivo(false);
  }

  function alterarMotoristaPreImportacao(conversationId, driverIdValue) {
    const driver = motoristas.find(item => String(item.id) === driverIdValue) ?? null;
    setPreImportacao(prev => ({
      ...prev,
      conversations: prev.conversations.map(conversation => {
        if (conversation.id !== conversationId) return conversation;
        const candidates = conversation.candidatos.map(candidate => {
          const updated = {
            ...candidate,
            driverId: driver?.id ?? null,
            driverName: driver?.nome ?? null,
          };
          updated.fingerprint = fingerprintRide(updated, updated.driverId);
          if (driver
            && updated.hasRideContext
            && updated.amountCents !== null
            && [
              "Motorista não identificado",
              "Mais de um motorista identificado",
              "Motorista da mensagem diverge do motorista identificado na conversa",
            ].includes(updated.reviewReason)) {
            updated.reviewReason = null;
          }
          return updated;
        });
        return {
          ...conversation,
          motorista: {
            driverId: driver?.id ?? null,
            driverName: driver?.nome ?? "",
            method: "seleção manual",
          },
          candidatos: candidates,
        };
      }),
    }));
  }

  function confirmarPreImportacao() {
    if (!preImportacao) return;

    setConferenciaExpandida(preImportacao.conversations.some(
      conversation => conversation.analysisMode === "manual",
    ));
    const now = currentTimestamp();
    const newRides = [];
    const newReviews = [];
    const newImports = [];
    const newLinks = [];
    const details = [];

    for (const conversation of preImportacao.conversations) {
      const selectedDriverId = conversation.motorista.driverId;
      if (selectedDriverId && !conversation.duplicada) {
        for (const label of new Set([
          conversation.arquivo,
          conversation.arquivoConversa,
          ...conversation.remetentes,
        ])) {
          if (label.trim()) newLinks.push({ label, driverId: selectedDriverId });
        }
      }
      if (conversation.duplicada || conversation.mensagensAnalisadas === 0) {
        details.push({
          nome: conversation.arquivoConversa,
          mensagensAnalisadas: conversation.mensagensAnalisadas,
          motoristas: selectedDriverId
            ? [motoristas.find(item => item.id === selectedDriverId)?.nome].filter(Boolean)
            : [],
          corridasImportadas: 0,
          itensConferencia: 0,
          duplicada: Boolean(conversation.duplicada),
          erro: conversation.erro || "Nenhuma corrida potencial identificada.",
          periodo: conversation.periodo,
          foraDoPeriodo: conversation.foraDoPeriodo ?? 0,
          calculos: [],
        });
        continue;
      }
      const signature = conversation.assinatura;
      if (conversation.candidatos.length === 0) {
        newImports.push({
          id: `${now}-${signature}`,
          nome: conversation.arquivo,
          arquivoConversa: conversation.arquivoConversa,
          assinatura: signature,
          driverId: conversation.motorista.driverId ?? null,
          importadoEm: currentIsoTimestamp(),
          mensagensAnalisadas: conversation.mensagensAnalisadas,
          motoristas: conversation.motoristasIdentificados,
          corridasImportadas: 0,
          itensConferencia: 0,
          analysisMode: conversation.analysisMode ?? "ai",
          manualFailureReason: conversation.manualFailureReason ?? "",
          mensagens: conversation.mensagens ?? undefined,
        });
        details.push({
          nome: conversation.arquivoConversa,
          mensagensAnalisadas: conversation.mensagensAnalisadas,
          analysisMode: conversation.analysisMode ?? "ai",
          motoristas: conversation.motorista.driverId
            ? [motoristas.find(item => String(item.id) === String(conversation.motorista.driverId))?.nome].filter(Boolean)
            : [],
          corridasImportadas: 0,
          itensConferencia: 0,
          duplicada: false,
          erro: conversation.erro || "",
          periodo: conversation.periodo,
          foraDoPeriodo: conversation.foraDoPeriodo ?? 0,
          calculos: [],
        });
        continue;
      }
      let acceptedCount = 0;
      let reviewCount = 0;
      for (const candidate of conversation.candidatos) {
        const driverId = conversation.motorista.driverId ?? candidate.driverId;
        const driver = motoristas.find(item => String(item.id) === String(driverId));
        const reviewReason = candidate.reviewReason
          ?? (!driver ? "Motorista não identificado" : null)
          ?? (candidate.amountCents === null ? "Valor não identificado" : null);
        const record = {
          ...candidate,
          driverId: driver?.id ?? null,
          driverName: driver?.nome ?? "",
          importacaoId: signature,
          arquivo: conversation.arquivo,
          arquivoConversa: conversation.arquivoConversa,
          amount: candidate.amountCents === null ? null : candidate.amountCents / 100,
        };
        if (reviewReason) {
          newReviews.push({
            ...record,
            reviewReason,
            driverIdRevisao: driver?.id ? String(driver.id) : "",
            valorRevisao: candidate.amountCents === null ? "" : String(candidate.amountCents / 100),
          });
          reviewCount += 1;
        } else {
          newRides.push(record);
          acceptedCount += 1;
        }
      }

      newImports.push({
        id: `${now}-${signature}`,
        nome: conversation.arquivo,
        arquivoConversa: conversation.arquivoConversa,
        assinatura: signature,
        driverId: conversation.motorista.driverId ?? null,
        importadoEm: currentIsoTimestamp(),
        mensagensAnalisadas: conversation.mensagensAnalisadas,
        motoristas: conversation.motoristasIdentificados,
        corridasImportadas: acceptedCount,
        itensConferencia: reviewCount,
        analysisMode: conversation.analysisMode ?? "ai",
        manualFailureReason: conversation.manualFailureReason ?? "",
        mensagens: conversation.mensagens ?? undefined,
      });
      const driverId = conversation.motorista.driverId;
      const conversationReviews = newReviews.filter(review => review.importacaoId === signature);
      const conversationRides = newRides.filter(ride => ride.importacaoId === signature);
      const weeks = new Set([...conversationReviews, ...conversationRides].map(ride => (
        inicioDaSemana(ride.date)
      )));
      const calculos = [...weeks].sort().map(start => {
        const end = deslocarDias(start, 6);
        const driver = motoristas.find(item => String(item.id) === String(driverId));
        const existingPeriodRides = todasCorridas.filter(ride => (
          String(ride.motoristaId) === String(driverId)
          && ride.data >= start
          && ride.data <= end
        ));
        const newPeriodRides = conversationRides.filter(ride => (
          ride.date >= start && ride.date <= end
        ));
        const calculation = driver
          ? createWeeklyDriverCalculation(
            driver,
            [...existingPeriodRides, ...newPeriodRides],
            start,
            end,
            0,
          )
          : null;
        return {
          start,
          end,
          count: calculation?.count ?? 0,
          revenueCents: calculation?.revenueCents ?? 0,
          rate: calculation?.rate ?? 0,
          commissionCents: calculation?.commissionCents ?? 0,
          netCents: calculation?.netCents ?? 0,
          pendingReviews: conversationReviews.filter(review => (
            review.date >= start && review.date <= end
          )).length,
        };
      });
      details.push({
        nome: conversation.arquivoConversa,
        mensagensAnalisadas: conversation.mensagensAnalisadas,
        analysisMode: conversation.analysisMode ?? "ai",
        motoristas: driverId
          ? [motoristas.find(item => item.id === driverId)?.nome].filter(Boolean)
          : [],
        corridasImportadas: acceptedCount,
        itensConferencia: reviewCount,
        duplicada: Boolean(conversation.duplicada),
        erro: "",
        periodo: conversation.periodo,
        foraDoPeriodo: conversation.foraDoPeriodo ?? 0,
        calculos,
      });
    }

    setImportacoes(prev => {
      const signatures = new Set(prev.map(item => item.assinatura));
      const uniqueImports = newImports.filter(item => {
        if (signatures.has(item.assinatura)) return false;
        signatures.add(item.assinatura);
        return true;
      });
      return [...uniqueImports, ...prev];
    });
    if (newImports.length === 1) {
      setFiltroImportacaoRevisao(newImports[0].assinatura);
      const importedConversation = preImportacao.conversations.find(
        conversation => conversation.assinatura === newImports[0].assinatura,
      );
      setFiltroMotoristaRevisao(
        importedConversation?.motorista.driverId
          ? String(importedConversation.motorista.driverId)
          : "",
      );
    } else {
      setFiltroImportacaoRevisao("");
      setFiltroMotoristaRevisao("");
    }
    const fingerprints = new Set(corridasImportadas.map(ride => ride.fingerprint));
    const uniqueRides = newRides.filter(ride => {
      if (fingerprints.has(ride.fingerprint)) return false;
      fingerprints.add(ride.fingerprint);
      return true;
    });
    setCorridasImportadas(prev => [...prev, ...uniqueRides]);
    if (uniqueRides.length > 0) {
      atualizarFechamentos([...todasCorridas, ...uniqueRides]);
    }
    setRevisoesImportacao(prev => {
      const ids = new Set(prev.map(review => review.id));
      const uniqueReviews = newReviews.filter(review => {
        if (ids.has(review.id)) return false;
        ids.add(review.id);
        return true;
      });
      return [...prev, ...uniqueReviews];
    });
    setVinculosWhatsApp(prev => {
      const merged = new Map(prev.map(link => [`${link.label}|${link.driverId}`, link]));
      newLinks.forEach(link => merged.set(`${link.label}|${link.driverId}`, link));
      return [...merged.values()];
    });
    setResultadoImportacao({
      arquivo: preImportacao.arquivos.join(", "),
      conversas: details,
      mensagensAnalisadas: details.reduce((sum, detail) => sum + detail.mensagensAnalisadas, 0),
      motoristas: [...new Set(details.flatMap(detail => detail.motoristas))],
      erros: [
        ...preImportacao.errors.map(error => `${error.arquivo}: ${error.mensagem}`),
        ...details.filter(detail => detail.erro).map(detail => `${detail.nome}: ${detail.erro}`),
      ],
    });
    const conversationErrorCount = details.filter(detail => detail.erro).length;
    setMensagemImportacao(
      `${newRides.length || newReviews.length ? "Importação concluída" : "Lote analisado"}: ${newRides.length} corrida(s) registrada(s), ${newReviews.length} pendente(s) de revisão, ${preImportacao.errors.length + conversationErrorCount} erro(s)/aviso(s).`,
    );
    if (preImportacao.motoristaId) {
      const skippedCount = preImportacao.conversations.reduce(
        (sum, conversation) => sum + (conversation.foraDoPeriodo ?? 0),
        0,
      );
      const driver = motoristas.find(item => (
        String(item.id) === String(preImportacao.motoristaId)
      ));
      setMensagensImportacaoMotoristas(previous => ({
        ...previous,
        [preImportacao.motoristaId]: `${newRides.length} corrida(s) aprovada(s), ${newReviews.length} item(ns) aguardando conferência.${skippedCount ? ` ${skippedCount} item(ns) fora do período foram ignorados.` : ""}${preImportacao.errors.length ? ` ${preImportacao.errors.length} arquivo(s) com erro.` : ""}`,
      }));
      if (driver) setFiltroMotoristaRevisao(String(driver.id));
    }
    setPreImportacao(null);
  }

  function alterarRevisaoImportacao(id, campo, valorAtualizado) {
    setRevisoesImportacao(prev => prev.map(revisao => (
      revisao.id === id
        ? {
          ...revisao,
          [campo]: valorAtualizado,
          ...(campo === "driverIdRevisao"
            ? { motoristaConfirmadoManualmente: Boolean(valorAtualizado) }
            : {}),
        }
        : revisao
    )));
  }

  function aprovarRevisao(revisao) {
    const requestedDriverId = revisao.driverIdRevisao || revisao.driverId || "";
    const motorista = motoristas.find(item => (
      String(item.id) === String(requestedDriverId)
    ));
    const driverIdRevisao = motorista?.id;
    const valorRevisao = Number(revisao.valorRevisao);
    const valorRevisaoCents = Math.round(valorRevisao * 100);
    const motoristaValido = Boolean(motorista);

    const corridaExistente = corridasImportadas.find(corrida => (
      corrida.fingerprint === revisao.fingerprint
      || (revisao.hasTripId
        && corrida.identity === revisao.identity
        && corrida.date === revisao.date
        && String(corrida.driverId) === String(driverIdRevisao))
    ));

    if (revisao.classification === "sistema") {
      setMensagemImportacao("Mensagens automáticas do sistema não podem ser aprovadas como corridas.");
      return;
    }

    if (revisao.classification === "confirmação") {
      setMensagemImportacao("Confirmações/repetições não podem ser aprovadas como novas corridas. Descarte após conferência.");
      return;
    }

    if (revisao.classification === "cancelamento") {
      if (!motoristaValido || !revisao.hasTripId) {
        setMensagemImportacao("Confirme o motorista antes de validar o cancelamento.");
        return;
      }
      if (corridaExistente) {
        setCorridasImportadas(prev => prev.filter(corrida => corrida.id !== corridaExistente.id));
        atualizarFechamentos(todasCorridas.filter(corrida => corrida.id !== corridaExistente.id));
      }
      setRevisoesImportacao(prev => prev.filter(item => item.id !== revisao.id));
      setMensagemImportacao(corridaExistente
        ? "Cancelamento confirmado; a corrida foi removida dos cálculos."
        : "Cancelamento confirmado; nenhum valor foi incluído no fechamento.");
      return;
    }

    if (revisao.classification === "correção" && !corridaExistente) {
      setMensagemImportacao("Correção sem corrida original identificável; não foi contabilizada como uma nova corrida.");
      return;
    }

    if (!motoristaValido || !Number.isFinite(valorRevisao) || valorRevisao <= 0) {
      setMensagemImportacao("Para aprovar, selecione o motorista correto e informe o valor confirmado da corrida.");
      return;
    }

    const aliasLinks = [revisao.arquivo, revisao.arquivoConversa, revisao.sender]
      .filter(Boolean)
      .map(label => ({ label, driverId: driverIdRevisao }));
    setVinculosWhatsApp(prev => {
      const merged = new Map(prev.map(link => [`${link.label}|${link.driverId}`, link]));
      aliasLinks.forEach(link => merged.set(`${link.label}|${link.driverId}`, link));
      return [...merged.values()];
    });

    if (corridaExistente) {
      const updatedRide = {
        ...corridaExistente,
        amount: valorRevisao,
        amountCents: valorRevisaoCents,
        driverId: driverIdRevisao,
        driverName: motorista?.nome,
        fingerprint: fingerprintRide({
          ...revisao,
          amountCents: valorRevisaoCents,
        }, driverIdRevisao),
        text: revisao.text,
        arquivo: revisao.arquivo,
      };
      setCorridasImportadas(prev => prev.map(corrida => (
        corrida.id === corridaExistente.id
          ? updatedRide
          : corrida
      )));
      atualizarFechamentos([
        ...todasCorridas.filter(ride => String(ride.id) !== String(corridaExistente.id)),
        updatedRide,
      ]);
      setRevisoesImportacao(prev => prev.filter(item => item.id !== revisao.id));
      setMensagemImportacao("Corrida existente atualizada após conferência do valor.");
      return;
    }

    const novaCorrida = {
        ...revisao,
        id: revisao.id,
        driverId: driverIdRevisao,
        driverName: motorista.nome,
        amount: valorRevisao,
        amountCents: valorRevisaoCents,
        analysisStatus: "confirmed",
        confirmed: true,
        fingerprint: fingerprintRide({
          ...revisao,
          amountCents: valorRevisaoCents,
        }, driverIdRevisao),
      };
    setCorridasImportadas(prev => (
      prev.some(corrida => corrida.fingerprint === novaCorrida.fingerprint)
        ? prev
        : [...prev, novaCorrida]
    ));
    if (!corridasImportadas.some(corrida => corrida.fingerprint === novaCorrida.fingerprint)) {
      atualizarFechamentos([...todasCorridas, novaCorrida]);
    }
    setRevisoesImportacao(prev => prev.filter(item => item.id !== revisao.id));
  }

  function aprovarCorridasValidasEmLote() {
    if (!filtroImportacaoRevisao || !filtroMotoristaRevisao) {
      setMensagemImportacao("Selecione uma importação e um motorista para aprovar em lote.");
      return;
    }

    const importacao = importacoes.find(
      item => item.assinatura === filtroImportacaoRevisao,
    );
    const driver = motoristas.find(
      item => String(item.id) === filtroMotoristaRevisao,
    );
    if (!importacao || !driver) {
      setMensagemImportacao("A importação ou o motorista selecionado não está mais disponível.");
      return;
    }

    const candidates = filterBulkApprovableReviews(revisoesImportacao.filter(review => (
      review.importacaoId === filtroImportacaoRevisao
      && String(review.driverIdRevisao || review.driverId || "") === String(driver.id)
    )), motoristas, corridasImportadas);
    if (candidates.length === 0) {
      setMensagemImportacao("Nenhuma corrida atende aos critérios seguros de aprovação em lote. Itens ambíguos continuam para revisão individual.");
      return;
    }

    const confirmed = window.confirm(
      `Aprovar ${candidates.length} corrida(s) válida(s) de ${driver.nome} nesta importação? Mensagens ambíguas, sem valor ou duplicadas ficarão pendentes.`,
    );
    if (!confirmed) return;

    const existingFingerprints = new Set(corridasImportadas.map(ride => ride.fingerprint));
    const approved = [];
    for (const review of candidates) {
      const driverId = Number(review.driverIdRevisao || review.driverId);
      const amountCents = Math.round(Number(review.valorRevisao) * 100);
      const fingerprint = fingerprintRide({ ...review, amountCents }, driverId);
      const duplicate = existingFingerprints.has(fingerprint)
        || corridasImportadas.some(ride => (
          review.hasTripId
          && ride.identity === review.identity
          && ride.date === review.date
          && String(ride.driverId) === String(driverId)
        ));
      if (duplicate) continue;

      const approvedRide = {
        ...review,
        driverId,
        driverName: driver.nome,
        amount: amountCents / 100,
        amountCents,
        fingerprint,
      };
      approved.push(approvedRide);
      existingFingerprints.add(fingerprint);
    }

    if (approved.length === 0) {
      setMensagemImportacao("Nenhuma corrida nova foi aprovada; os itens já processados foram preservados sem duplicação.");
      return;
    }

    const approvedIds = new Set(approved.map(ride => ride.id));
    const nextRides = [...corridasImportadas, ...approved];
    setCorridasImportadas(nextRides);
    setRevisoesImportacao(prev => prev.filter(review => !approvedIds.has(review.id)));
    atualizarFechamentos([...todasCorridas, ...approved]);
    setImportacoes(prev => prev.map(item => (
      item.assinatura === filtroImportacaoRevisao
        ? {
          ...item,
          corridasImportadas: Number(item.corridasImportadas ?? 0) + approved.length,
          itensConferencia: Math.max(0, Number(item.itensConferencia ?? 0) - approved.length),
          ultimaAprovacaoEm: currentIsoTimestamp(),
        }
        : item
    )));
    setVinculosWhatsApp(prev => {
      const merged = new Map(prev.map(link => [`${link.label}|${link.driverId}`, link]));
      approved.flatMap(review => [review.arquivo, review.arquivoConversa, review.sender]
        .filter(Boolean)
        .map(label => ({ label, driverId: driver.id })))
        .forEach(link => merged.set(`${link.label}|${link.driverId}`, link));
      return [...merged.values()];
    });
    setPaginaRevisoes(0);
    setMensagemImportacao(
      `${approved.length} corrida(s) válida(s) de ${driver.nome} aprovada(s) e salvas. Os itens ambíguos ou inválidos permanecem na conferência; a importação anterior continua no histórico e o seletor de arquivo está pronto para outro motorista.`,
    );
  }

  function descartarRevisao(revisaoId) {
    setRevisoesImportacao(prev => prev.filter(revisao => revisao.id !== revisaoId));
  }

  function adicionarCorrida(e) {
    e.preventDefault();
    if (!motoristaId || Number(valor) <= 0) return;
    const valorCents = Math.round(Number(valor) * 100);
    const novaCorrida = {
      id: currentTimestamp(),
      motoristaId: Number(motoristaId),
      valor: valorCents / 100,
      valorCentavos: valorCents,
      data,
    };

    setCorridas(prev => [...prev, novaCorrida]);
    atualizarFechamentos([...todasCorridas, novaCorrida]);
    setValor("");
  }

  function adicionarPagamento(e) {
    e.preventDefault();
    const valorDoPagamento = Number(novoPagamento.valor);

    if (!novoPagamento.motoristaId || !Number.isFinite(valorDoPagamento) || valorDoPagamento <= 0) {
      return;
    }

    setPagamentos(prev => [
      {
        id: currentTimestamp(),
        motoristaId: Number(novoPagamento.motoristaId),
        valor: valorDoPagamento,
        data: novoPagamento.data,
        status: novoPagamento.status,
      },
      ...prev,
    ]);

    setNovoPagamento(prev => ({
      ...prev,
      valor: "",
      status: "pendente",
    }));
  }

  function adicionarTransacao(e) {
    e.preventDefault();
    const valorDaTransacao = Number(novaTransacao.valor);

    if (!Number.isFinite(valorDaTransacao) || !novaTransacao.descricao.trim()) {
      return;
    }

    setTransacoes(prev => [
      {
        id: currentTimestamp(),
        tipo: novaTransacao.tipo,
        data: novaTransacao.data,
        valor: valorDaTransacao,
        descricao: novaTransacao.descricao.trim(),
      },
      ...prev,
    ]);

    setNovaTransacao(prev => ({
      ...prev,
      valor: "",
      descricao: "",
    }));
  }

  function atualizarPagamentoStatus(pagamentoId, status) {
    setPagamentos(prev => prev.map(pagamento => (
      pagamento.id === pagamentoId ? { ...pagamento, status } : pagamento
    )));
  }

  const todasCorridas = [
    ...corridas.filter(ride => ride.excludedFromTotals !== true).map(ride => ({
      id: ride.id,
      motoristaId: ride.motoristaId,
      data: ride.data,
      valor: ride.valor,
      valorCentavos: rideAmountInCents(ride) ?? 0,
      amountCents: rideAmountInCents(ride) ?? 0,
      time: ride.horario ?? "",
    })),
    ...corridasImportadas.filter(ride => ride.excludedFromTotals !== true).map(ride => ({
      id: ride.id,
      motoristaId: ride.driverId,
      data: ride.date,
      valor: ride.amount,
      valorCentavos: rideAmountInCents(ride) ?? 0,
      amountCents: rideAmountInCents(ride) ?? 0,
      time: ride.time ?? "",
    })),
  ];
  const corridasRelatorio = todasCorridas
    .filter(ride => !filtroMotoristaRelatorio || String(ride.motoristaId) === filtroMotoristaRelatorio)
    .filter(ride => !filtroInicioRelatorio || ride.data >= filtroInicioRelatorio)
    .filter(ride => !filtroFimRelatorio || ride.data <= filtroFimRelatorio)
    .sort((left, right) => (
      right.data.localeCompare(left.data) || String(right.time).localeCompare(String(left.time))
    ));
  const tamanhoPagina = 50;
  const paginaRelatorioAtual = Math.min(
    paginaRelatorio,
    Math.max(0, Math.ceil(corridasRelatorio.length / tamanhoPagina) - 1),
  );
  const corridasImportadasOrdenadas = [...corridasImportadas]
    .sort((left, right) => right.date.localeCompare(left.date));
  const paginaCorridasImportadasAtual = Math.min(
    paginaCorridasImportadas,
    Math.max(0, Math.ceil(corridasImportadasOrdenadas.length / tamanhoPagina) - 1),
  );
  const corridasImportadasPagina = corridasImportadasOrdenadas.slice(
    paginaCorridasImportadasAtual * tamanhoPagina,
    (paginaCorridasImportadasAtual + 1) * tamanhoPagina,
  );
  const ridesPerWeek = new Map();
  for (const ride of todasCorridas) {
    const key = `${ride.motoristaId}|${inicioDaSemana(ride.data)}`;
    ridesPerWeek.set(key, (ridesPerWeek.get(key) ?? 0) + 1);
  }
  const ridesByReportWeek = new Map();
  for (const ride of corridasRelatorio) {
    const key = `${ride.motoristaId}|${inicioDaSemana(ride.data)}`;
    ridesByReportWeek.set(key, [...(ridesByReportWeek.get(key) ?? []), ride]);
  }
  const reportCommissionByRide = new Map();
  for (const [key, weeklyRides] of ridesByReportWeek) {
    const driver = motoristas.find(item => String(item.id) === String(weeklyRides[0].motoristaId));
    const countInWeek = ridesPerWeek.get(key) ?? 0;
    const rate = driver ? automaticCommission(driver, countInWeek) : 0;
    const allocations = allocateCommissionCents(weeklyRides, rate);
    weeklyRides.forEach((ride, index) => {
      reportCommissionByRide.set(ride, allocations[index]);
    });
  }
  const detalhesRelatorio = corridasRelatorio.map(ride => {
    const driver = motoristas.find(item => item.id === ride.motoristaId);
    const weekStart = inicioDaSemana(ride.data);
    const countInWeek = ridesPerWeek.get(`${ride.motoristaId}|${weekStart}`) ?? 0;
    const rate = driver ? automaticCommission(driver, countInWeek) : 0;
    const commissionCents = reportCommissionByRide.get(ride) ?? 0;
    return {
      ...ride,
      driver,
      rate,
      commission: commissionCents / 100,
      net: (ride.amountCents - commissionCents) / 100,
    };
  });
  const detalhesRelatorioPagina = detalhesRelatorio.slice(
    paginaRelatorioAtual * tamanhoPagina,
    (paginaRelatorioAtual + 1) * tamanhoPagina,
  );
  const reportRevenueCents = detalhesRelatorio.reduce((sum, ride) => sum + ride.amountCents, 0);
  const reportCommission = detalhesRelatorio.reduce((sum, ride) => sum + ride.commission, 0);
  const reportNet = reportRevenueCents / 100 - reportCommission;
  const totalCents = todasCorridas.reduce((sum, ride) => sum + ride.amountCents, 0);
  const total = totalCents / 100;

  const semanaFim = deslocarDias(semanaInicio, 6);
  const corridasDaSemana = todasCorridas.filter(
    ride => ride.data >= semanaInicio && ride.data <= semanaFim,
  );
  const resumoPorMotorista = motoristas.map(driver => {
    const totals = calculateDriverPeriodTotals(
      todasCorridas,
      driver,
      resumoInicio,
      resumoFim,
    );
    return {
      driver,
      count: totals.count,
      revenue: totals.revenueCents / 100,
      commission: totals.commissionCents / 100,
      net: totals.netCents / 100,
      rate: totals.rate,
    };
  });
  const resumoGeralDoPeriodo = resumoPorMotorista.reduce((summary, driverSummary) => ({
    trips: summary.trips + driverSummary.count,
    gross: summary.gross + driverSummary.revenue,
    commission: summary.commission + driverSummary.commission,
    net: summary.net + driverSummary.net,
  }), { trips: 0, gross: 0, commission: 0, net: 0 });
  const resumoImportacaoSemanal = summarizeImportWeek(
    todasCorridas,
    motoristas,
    pagamentos,
    semanaInicio,
    semanaFim,
  );
  const faturamentoDaSemana = corridasDaSemana.reduce((sum, ride) => sum + ride.amountCents, 0) / 100;
  const comissoesDaSemana = resumoImportacaoSemanal.reduce(
    (sum, summary) => sum + summary.commissionDue,
    0,
  );
  const comissoesDaBase = motoristas.reduce(
    (sum, driver) => sum + summarizeDriverRides(todasCorridas, driver).comissao,
    0,
  );

  function resumo(motorista) {
    return summarizeDriverRides(corridasDaSemana, motorista);
  }

  function resumoDaSemana(motorista) {
    const lista = corridasDaSemana.filter(corrida => corrida.motoristaId === motorista.id);
    const faturamentoCents = lista.reduce((sum, ride) => sum + ride.amountCents, 0);
    const summary = resumoImportacaoSemanal.find(item => item.driver.id === motorista.id);
    return {
      quantidade: lista.length,
      faturamento: faturamentoCents / 100,
      percentual: summary?.rate ?? automaticCommission(motorista, lista.length),
      comissao: summary?.commissionDue ?? 0,
      liquido: summary?.baseDue ?? 0,
    };
  }

  const diasDaSemana = Array.from({ length: 7 }, (_, indice) => {
    const dataDoDia = deslocarDias(semanaInicio, indice);
    const corridasDoDia = corridasDaSemana.filter(corrida => corrida.data === dataDoDia);
    const comissaoDoDia = motoristas.reduce((sum, motorista) => {
      const weeklyCount = corridasDaSemana.filter(ride => ride.motoristaId === motorista.id).length;
      const dailyCommissionCents = corridasDoDia
        .filter(ride => ride.motoristaId === motorista.id)
        .reduce((dailySum, ride) => (
          dailySum + Math.round(ride.amountCents * automaticCommission(motorista, weeklyCount) / 100)
        ), 0);
      return sum + dailyCommissionCents / 100;
    }, 0);
    return {
      data: dataDoDia,
      nome: formatarData(dataDoDia, { weekday: "short" }).replace(".", ""),
      faturamento: corridasDoDia.reduce((sum, ride) => sum + ride.amountCents, 0) / 100,
      comissao: comissaoDoDia,
    };
  });

  const saldoDisponivel = useMemo(() => {
    const faturamentoTotalCents = [...corridas, ...corridasImportadas]
      .reduce((sum, ride) => sum + Number(rideAmountInCents(ride) ?? 0), 0);
    const faturamentoTotal = faturamentoTotalCents / 100;
    const pagamentosConfirmados = pagamentos
      .filter(pagamento => pagamento.status === "confirmado")
      .reduce((soma, pagamento) => soma + pagamento.valor, 0);
    const ajustes = transacoes.reduce((soma, transacao) => {
      if (transacao.tipo === "entrada") {
        return soma + Number(transacao.valor || 0);
      }
      if (transacao.tipo === "saida") {
        return soma - Number(transacao.valor || 0);
      }
      return soma + Number(transacao.valor || 0);
    }, 0);

    return faturamentoTotal - pagamentosConfirmados + ajustes;
  }, [corridas, corridasImportadas, pagamentos, transacoes]);

  const pagamentosDaSemana = pagamentos.filter(pagamento => (
    pagamento.data >= semanaInicio && pagamento.data <= semanaFim
  ));

  const comissoesRecebidasSemana = pagamentosDaSemana
    .filter(pagamento => pagamento.status === "confirmado")
    .reduce((soma, pagamento) => soma + pagamento.valor, 0);

  const comissoesPendentesSemana = pagamentosDaSemana
    .filter(pagamento => pagamento.status === "pendente")
    .reduce((soma, pagamento) => soma + pagamento.valor, 0);

  const revisoesImportacaoDaSemana = revisoesImportacao.filter(revisao => (
    revisao.date >= semanaInicio && revisao.date <= semanaFim
    && revisao.classification !== "sistema"
  ));
  const revisoesConferencia = revisoesImportacao.filter(review => (
    (!filtroImportacaoRevisao || review.importacaoId === filtroImportacaoRevisao)
    && (!filtroMotoristaRevisao
      || String(review.driverIdRevisao || review.driverId || "") === filtroMotoristaRevisao)
  ));
  const corridasValidasEmLote = filtroImportacaoRevisao && filtroMotoristaRevisao
    ? filterBulkApprovableReviews(revisoesConferencia, motoristas, corridasImportadas)
    : [];
  const paginaRevisoesAtual = Math.min(
    paginaRevisoes,
    Math.max(0, Math.ceil(revisoesConferencia.length / tamanhoPagina) - 1),
  );
  const revisoesImportacaoPagina = revisoesConferencia.slice(
    paginaRevisoesAtual * tamanhoPagina,
    (paginaRevisoesAtual + 1) * tamanhoPagina,
  );
  const faturamentoImportadoDaSemana = resumoImportacaoSemanal
    .reduce((soma, resumoMotorista) => soma + resumoMotorista.revenue, 0);
  const comissaoImportadaDaSemana = resumoImportacaoSemanal
    .reduce((soma, resumoMotorista) => soma + resumoMotorista.commissionDue, 0);

  function atualizarFechamentos(rides = todasCorridas, drivers = motoristas) {
    setFechamentos(previous => appendCalculationRevisions(previous, drivers, rides));
  }

  const fechamentoSemanalPorMotorista = motoristas.map(driver => {
    const rides = corridasDaSemana.filter(
      ride => String(ride.motoristaId) === String(driver.id),
    );
    const calculation = createWeeklyDriverCalculation(
      driver,
      rides,
      semanaInicio,
      semanaFim,
      0,
    );
    const history = fechamentos.filter(item => (
      String(item.driverId) === String(driver.id)
      && item.start === semanaInicio
      && item.end === semanaFim
    ));
    const latest = history.reduce(
      (best, item) => (!best || item.revision > best.revision ? item : best),
      null,
    );
    const current = Boolean(
      latest
      && latest.sourceFingerprint === calculation.sourceFingerprint
      && latest.rate === calculation.rate,
    );
    const pendingReviews = revisoesImportacao.filter(review => (
      review.date >= semanaInicio
      && review.date <= semanaFim
      && review.classification !== "sistema"
      && String(review.driverIdRevisao || review.driverId || "") === String(driver.id)
    )).length;
    const status = current
      ? "Calculado"
      : latest
        ? "Revisão necessária"
        : calculation.count > 0
          ? "Aguardando cálculo"
          : pendingReviews > 0
            ? "Aguardando revisão"
            : "Aguardando importação";
    return {
      driver,
      calculation: latest ?? calculation,
      preview: calculation,
      current,
      status,
      pendingReviews,
      revisionCount: history.length,
      history: [...history].sort((left, right) => left.revision - right.revision),
    };
  });
  const fechamentosAtuais = fechamentoSemanalPorMotorista.filter(item => item.current);
  const resumoFechamento = fechamentosAtuais.reduce((summary, item) => ({
    drivers: summary.drivers + 1,
    rides: summary.rides + item.calculation.count,
    revenueCents: summary.revenueCents + item.calculation.revenueCents,
    commissionCents: summary.commissionCents + item.calculation.commissionCents,
  }), { drivers: 0, rides: 0, revenueCents: 0, commissionCents: 0 });
  const motoristasAguardando = fechamentoSemanalPorMotorista.length - fechamentosAtuais.length;

  const extratoFinanceiro = useMemo(() => {
    const confirmados = pagamentos
      .filter(pagamento => pagamento.status === "confirmado")
      .map(pagamento => {
        const motorista = motoristas.find(item => item.id === pagamento.motoristaId);
        return {
          id: `pagamento-${pagamento.id}`,
          tipo: "saida",
          data: pagamento.data,
          valor: pagamento.valor,
          descricao: `Pagamento confirmado • ${motorista?.nome ?? "Motorista"}`,
        };
      });

    const transacoesFormatadas = transacoes.map(transacao => ({
      id: `ajuste-${transacao.id}`,
      tipo: transacao.tipo,
      data: transacao.data,
      valor: Number(transacao.valor || 0),
      descricao: transacao.descricao,
    }));

    return [...confirmados, ...transacoesFormatadas]
      .sort((a, b) => (a.data < b.data ? 1 : -1));
  }, [motoristas, pagamentos, transacoes]);

  function exportarRelatorioImportacao() {
    const linhas = [
      ["Semana", "Motorista", "Corridas aprovadas", "Faturamento bruto", "Percentual", "Comissão à central", "Líquido ao motorista", "Comissão recebida", "Comissão pendente"],
      ...resumoImportacaoSemanal.map(resumoMotorista => [
        `${semanaInicio} a ${semanaFim}`,
        resumoMotorista.driver.nome,
        resumoMotorista.count,
        resumoMotorista.revenue.toFixed(2),
        `${resumoMotorista.rate}%`,
        resumoMotorista.commissionDue.toFixed(2),
        resumoMotorista.baseDue.toFixed(2),
        resumoMotorista.paid.toFixed(2),
        resumoMotorista.pending.toFixed(2),
      ]),
    ];
    const csv = linhas
      .map(linha => linha.map(valor => `"${String(valor).replaceAll('"', '""')}"`).join(";"))
      .join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `relatorio-whatsapp-${semanaInicio}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function exportarDetalhesCSV() {
    const linhas = [
      ["Data", "Horário", "Motorista", "Valor", "Percentual", "Comissão central", "Líquido", "Origem"],
      ...detalhesRelatorio.map(ride => [
        ride.data,
        ride.time,
        ride.driver?.nome ?? "Não identificado",
        (ride.amountCents / 100).toFixed(2),
        `${ride.rate}%`,
        ride.commission.toFixed(2),
        ride.net.toFixed(2),
        ride.arquivo ? "WhatsApp" : "Manual",
      ]),
    ];
    const csv = linhas
      .map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(";"))
      .join("\n");
    const url = URL.createObjectURL(new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" }));
    const link = document.createElement("a");
    link.href = url;
    const nomeMotorista = motoristas.find(
      driver => String(driver.id) === filtroMotoristaRelatorio,
    )?.nome.replace(/[^a-z0-9-]+/gi, "-").toLocaleLowerCase("pt-BR") ?? "geral";
    link.download = `relatorio-corridas-${nomeMotorista}-${filtroInicioRelatorio || semanaInicio}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function exportarImagemFechamentoGeral() {
    const linhas = fechamentoSemanalPorMotorista.map(item => {
      const calculation = item.current ? item.calculation : item.preview;
      return {
        nome: item.driver.nome,
        corridas: calculation.count,
        faturamento: calculation.revenueCents,
        comissao: calculation.commissionCents,
        liquido: calculation.netCents,
        status: item.current ? "FECHADO" : "PENDENTE",
      };
    });
    const largura = 1400;
    const altura = Math.max(760, 570 + linhas.length * 54);
    const escala = 2;
    const canvas = document.createElement("canvas");
    canvas.width = largura * escala;
    canvas.height = altura * escala;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      setMensagemImportacao("Não foi possível gerar a imagem neste navegador.");
      return;
    }

    ctx.scale(escala, escala);
    ctx.fillStyle = "#f3f7f4";
    ctx.fillRect(0, 0, largura, altura);
    ctx.fillStyle = "#123d2b";
    ctx.fillRect(0, 0, largura, 210);
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 25px Arial";
    ctx.fillText("XAMA MOBILIDADE URBANA", 70, 62);
    ctx.font = "bold 48px Arial";
    ctx.fillText("FECHAMENTO SEMANAL", 70, 125);
    ctx.font = "24px Arial";
    ctx.fillStyle = "#d7e9dd";
    ctx.fillText(`${formatarData(semanaInicio)} a ${formatarData(semanaFim)}`, 70, 170);

    const cards = [
      ["MOTORISTAS FECHADOS", String(resumoFechamento.drivers)],
      ["CORRIDAS VÁLIDAS", String(resumoFechamento.rides)],
      ["FATURAMENTO BRUTO", dinheiroComPrefixo(resumoFechamento.revenueCents / 100)],
      ["COMISSÃO XAMA", dinheiroComPrefixo(resumoFechamento.commissionCents / 100)],
    ];
    const cardY = 245;
    const cardW = 295;
    cards.forEach(([label, value], index) => {
      const x = 70 + index * 315;
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.roundRect(x, cardY, cardW, 112, 14);
      ctx.fill();
      ctx.fillStyle = "#587164";
      ctx.font = "bold 16px Arial";
      ctx.fillText(label, x + 20, cardY + 35);
      ctx.fillStyle = "#123d2b";
      ctx.font = "bold 30px Arial";
      ctx.fillText(value, x + 20, cardY + 82);
    });

    const tableY = 405;
    const columns = [70, 520, 690, 850, 1080, 1230];
    ctx.fillStyle = "#dceae1";
    ctx.fillRect(70, tableY, 1260, 48);
    ctx.fillStyle = "#17432f";
    ctx.font = "bold 17px Arial";
    ["MOTORISTA", "CORRIDAS", "FATURAMENTO", "COMISSÃO", "LÍQUIDO", "STATUS"].forEach((label, index) => {
      ctx.fillText(label, columns[index] + 12, tableY + 30);
    });
    linhas.forEach((item, index) => {
      const y = tableY + 48 + index * 54;
      ctx.fillStyle = index % 2 === 0 ? "#ffffff" : "#edf3ef";
      ctx.fillRect(70, y, 1260, 54);
      ctx.fillStyle = "#203c2e";
      ctx.font = "16px Arial";
      ctx.fillText(item.nome.slice(0, 30), columns[0] + 12, y + 33);
      ctx.fillText(String(item.corridas), columns[1] + 12, y + 33);
      ctx.fillText(dinheiroComPrefixo(item.faturamento / 100), columns[2] + 12, y + 33);
      ctx.fillText(dinheiroComPrefixo(item.comissao / 100), columns[3] + 12, y + 33);
      ctx.fillText(dinheiroComPrefixo(item.liquido / 100), columns[4] + 12, y + 33);
      ctx.fillStyle = item.status === "FECHADO" ? "#187346" : "#9a6817";
      ctx.font = "bold 14px Arial";
      ctx.fillText(item.status, columns[5] + 12, y + 33);
    });
    ctx.fillStyle = "#587164";
    ctx.font = "15px Arial";
    ctx.fillText(
      "Somente fechamentos aprovados compõem os indicadores gerais. Valores pendentes estão identificados na tabela.",
      70,
      altura - 35,
    );
    canvas.toBlob(blob => {
      if (!blob) {
        setMensagemImportacao("Falha ao gerar o PNG. Tente novamente.");
        return;
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `fechamento-geral-xama-${semanaInicio}.png`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, "image/png");
  }

  function exportarFechamentoConsolidado() {
    const linhas = [
      ["Período", "Motorista", "Corridas válidas", "Faturamento bruto", "Percentual", "Comissão Xama", "Restante motorista", "Situação"],
      ...fechamentoSemanalPorMotorista.map(item => {
        const calculation = item.current ? item.calculation : item.preview;
        return [
          `${semanaInicio} a ${semanaFim}`,
          item.driver.nome,
          calculation.count,
          (calculation.revenueCents / 100).toFixed(2),
          `${calculation.rate}%`,
          (calculation.commissionCents / 100).toFixed(2),
          (calculation.netCents / 100).toFixed(2),
          item.status,
        ];
      }),
    ];
    const csv = linhas
      .map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(";"))
      .join("\n");
    const url = URL.createObjectURL(new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `fechamento-motoristas-${semanaInicio}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function abrirRelatorioMotorista(driverId) {
    setFiltroMotoristaRelatorio(String(driverId));
    setFiltroInicioRelatorio(semanaInicio);
    setFiltroFimRelatorio(semanaFim);
    setRelatoriosAbertos(true);
    window.setTimeout(() => {
      document.getElementById("relatorio-detalhado")?.scrollIntoView({ behavior: "smooth" });
    }, 0);
  }

  function imprimirRelatorioPdf() {
    const popup = window.open("", "_blank");
    if (!popup) {
      setMensagemImportacao("O navegador bloqueou a janela de impressão. Permita pop-ups para gerar/salvar o PDF.");
      return;
    }

    const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#39;",
    })[character]);
    const rows = detalhesRelatorio.map(ride => (
      `<tr><td>${escapeHtml(formatarData(ride.data))}</td><td>${escapeHtml(ride.time || "—")}</td>`
      + `<td>${escapeHtml(ride.driver?.nome ?? "Não identificado")}</td>`
      + `<td>${escapeHtml(dinheiroComPrefixo(ride.amountCents / 100))}</td>`
      + `<td>${ride.rate}%</td><td>${escapeHtml(dinheiroComPrefixo(ride.commission))}</td>`
      + `<td>${escapeHtml(dinheiroComPrefixo(ride.net))}</td></tr>`
    )).join("");
    const reportDriverName = motoristas.find(
      driver => String(driver.id) === filtroMotoristaRelatorio,
    )?.nome ?? "Todos os motoristas";
    const reportRates = [...new Set(detalhesRelatorio.map(ride => ride.rate))];
    const reportRateLabel = reportRates.length === 1
      ? `${reportRates[0]}%`
      : reportRates.length > 1
        ? "Variável por semana"
        : "—";
    popup.document.write(
      `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Relatório CRM Xama</title>`
      + `<style>body{font:12px Arial,sans-serif;color:#173b2b;padding:24px}h1{font-size:20px}`
      + `table{width:100%;border-collapse:collapse;margin-top:16px;table-layout:fixed}`
      + `th,td{border:1px solid #ccc;padding:7px;text-align:left;overflow-wrap:anywhere}`
      + `th{background:#e8f1ec}thead{display:table-header-group}`
      + `tr{break-inside:avoid;page-break-inside:avoid}`
      + `@page{size:landscape;margin:12mm}@media print{body{padding:0;font-size:10px}`
      + `h1{font-size:18px}th,td{padding:5px}}</style><body>`
      + `<h1>Relatório de corridas — Xama Mobilidade Urbana</h1>`
      + `<p>Motorista: ${escapeHtml(reportDriverName)} · Corridas: ${detalhesRelatorio.length} · Percentual: ${escapeHtml(reportRateLabel)}</p>`
      + `<p>Período: ${escapeHtml(filtroInicioRelatorio || "início do histórico")} a ${escapeHtml(filtroFimRelatorio || "data atual")}</p>`
      + `<p>Faturamento: ${escapeHtml(dinheiroComPrefixo(reportRevenueCents / 100))} · `
      + `Comissão central: ${escapeHtml(dinheiroComPrefixo(reportCommission))} · `
      + `Líquido: ${escapeHtml(dinheiroComPrefixo(reportNet))}</p>`
      + `<table><thead><tr><th>Data</th><th>Hora</th><th>Motorista</th><th>Valor</th>`
      + `<th>%</th><th>Comissão central</th><th>Líquido</th></tr></thead><tbody>${rows}</tbody></table>`
      + `</body></html>`,
    );
    popup.document.close();
    popup.focus();
    popup.print();
  }

  function exportarCSV() {
    const linhas = [
      ["Período", "Motorista", "Corridas", "Faturamento", "Comissão", "Percentual"],
      ...motoristas.map(motorista => {
        const resumoMotorista = resumo(motorista);
        return [
          "Histórico completo",
          motorista.nome,
          resumoMotorista.quantidade,
          resumoMotorista.faturamento.toFixed(2),
          resumoMotorista.comissao.toFixed(2),
          motorista.comissaoEspecial ? `${motorista.comissao}% especial` : "Regra semanal",
        ];
      }),
    ];

    const csv = linhas
      .map(linha =>
        linha
          .map(valor => `"${String(valor).replaceAll('"', '""')}"`)
          .join(";"),
      )
      .join("\n");
    const blob = new Blob(["\uFEFF" + csv], {
      type: "text/csv;charset=utf-8;",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "relatorio-xama.csv";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  return (
    <main className="crm">
      <header className="topo">
        <div className="identidade">
          <span className="marca-simbolo" aria-hidden="true">X</span>
          <div>
            <span className="marca">XAMA MOBILIDADE URBANA</span>
            <h1>Controle de corridas</h1>
            <p>Gestão de motoristas, carteira e fechamento semanal</p>
          </div>
        </div>
        <div className="acoes-topo">
          <button className="botao-secundario" onClick={() => window.print()}>
            Imprimir relatório
          </button>
          <button className="botao-secundario" onClick={exportarImagemFechamentoGeral}>
            Baixar fechamento semanal PNG
          </button>
          <button
            type="button"
            className="botao-secundario"
            aria-expanded={relatoriosAbertos}
            onClick={() => setRelatoriosAbertos(open => !open)}
          >
            {relatoriosAbertos ? "Ocultar relatórios" : "Ver fechamento e relatórios"}
          </button>
          <button onClick={exportarCSV}>Exportar relatório CSV</button>
          {user && (
            <div className="xama-account-actions">
              <span>{user.email}</span>
              {user.role === "admin" && (
                <details onToggle={event => {
                  if (event.currentTarget.open) void carregarUsuarios();
                }}>
                  <summary>Contas de acesso</summary>
                  <ul className="xama-access-users">
                    {usuariosAcesso.map(account => (
                      <li key={account.id}>
                        <span>{account.email} · {account.active ? account.role : "desativada"}</span>
                        {account.id !== user.id && (
                          <button
                            type="button"
                            className="botao-secundario"
                            onClick={() => alterarStatusUsuario(account)}
                          >
                            {account.active ? "Desativar" : "Reativar"}
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                  <form onSubmit={criarUsuario}>
                    <label>
                      E-mail
                      <input
                        type="email"
                        autoComplete="email"
                        required
                        value={novoUsuarioEmail}
                        onChange={event => setNovoUsuarioEmail(event.target.value)}
                      />
                    </label>
                    <label>
                      Senha inicial (mínimo 12 caracteres)
                      <input
                        type="password"
                        autoComplete="new-password"
                        minLength={12}
                        required
                        value={novoUsuarioPassword}
                        onChange={event => setNovoUsuarioPassword(event.target.value)}
                      />
                    </label>
                    <button type="submit">Criar conta individual</button>
                    {mensagemUsuario && <small role="status">{mensagemUsuario}</small>}
                  </form>
                </details>
              )}
              <details>
                <summary>Minha senha</summary>
                <form onSubmit={alterarSenhaDaConta}>
                  <label>
                    Senha atual
                    <input
                      type="password"
                      autoComplete="current-password"
                      required
                      value={senhaAtual}
                      onChange={event => setSenhaAtual(event.target.value)}
                    />
                  </label>
                  <label>
                    Nova senha (mínimo 12 caracteres)
                    <input
                      type="password"
                      autoComplete="new-password"
                      minLength={12}
                      maxLength={1024}
                      required
                      value={senhaNova}
                      onChange={event => setSenhaNova(event.target.value)}
                    />
                  </label>
                  <button type="submit">Atualizar senha</button>
                  {mensagemSenha && <small role="status">{mensagemSenha}</small>}
                </form>
              </details>
              <button type="button" className="botao-secundario" onClick={onLogout}>
                Sair
              </button>
            </div>
          )}
        </div>
      </header>
      {workspaceError && (
        <div className="xama-workspace-error" role="alert">
          <span>{workspaceError}</span>
          {onReloadWorkspace && (
            <button type="button" onClick={onReloadWorkspace}>
              Baixar backup local e carregar dados do servidor
            </button>
          )}
          {!onReloadWorkspace && onRetrySync && (
            <button type="button" onClick={onRetrySync}>
              Tentar sincronizar novamente
            </button>
          )}
        </div>
      )}

      <section className="indicadores" aria-label="Indicadores históricos">
        <article className="cartao-indicador">
          <span className="indicador-icone icone-corridas" aria-hidden="true">↗</span>
          <div><span className="rotulo-indicador">Corridas registradas</span><strong>{corridas.length + corridasImportadas.length}</strong></div>
          <small>Todos os períodos</small>
        </article>
        <article className="cartao-indicador">
          <span className="indicador-icone icone-faturamento" aria-hidden="true">R$</span>
          <div><span className="rotulo-indicador">Faturamento total</span><strong>{dinheiroComPrefixo(total)}</strong></div>
          <small>Todos os períodos</small>
        </article>
        <article className="cartao-indicador">
          <span className="indicador-icone icone-comissao" aria-hidden="true">%</span>
          <div><span className="rotulo-indicador">Comissão central</span><strong>{dinheiroComPrefixo(comissoesDaBase)}</strong></div>
          <small>Todos os períodos</small>
        </article>
      </section>

      <div className="abas-navegacao" aria-label="Abas do sistema">
        <button
          type="button"
          className={abaAtiva === "operacao" ? "aba-botao ativa" : "aba-botao"}
          onClick={() => setAbaAtiva("operacao")}
        >
          Operações
        </button>
        <button
          type="button"
          className={abaAtiva === "carteira" ? "aba-botao ativa" : "aba-botao"}
          onClick={() => setAbaAtiva("carteira")}
        >
          Carteira
        </button>
      </div>

      {abaAtiva === "operacao" && (
        <>
          <div className="colunas-formularios">
            <section className="painel painel-formulario">
              <div className="titulo-painel">
                <span className="numero-etapa">01</span>
                <div><h2>Cadastrar motorista</h2><p>Defina o nome e a comissão individual.</p></div>
              </div>
              <form onSubmit={adicionarMotorista} className="formulario">
                <label htmlFor="nome-motorista">Nome do motorista</label>
                <input
                  id="nome-motorista"
                  placeholder="Ex.: Marina Souza"
                  value={nome}
                  onChange={e => setNome(e.target.value)}
                  required
                />
                <label htmlFor="modo-comissao-novo">Modo de comissão</label>
                <select
                  id="modo-comissao-novo"
                  value={modoComissaoNovo}
                  onChange={event => setModoComissaoNovo(event.target.value)}
                >
                  <option value="automatica">Regra automática semanal</option>
                  <option value="especial">Percentual especial individual</option>
                </select>
                <label htmlFor="comissao-motorista">Percentual especial individual</label>
                <input
                  id="comissao-motorista"
                  type="number"
                  min="0"
                  max="100"
                  step="0.1"
                  value={percentual}
                  onChange={e => setPercentual(e.target.value)}
                  disabled={modoComissaoNovo !== "especial"}
                />
                <label htmlFor="regra-genero">Regra automática para importações</label>
                <select
                  id="regra-genero"
                  value={generoRegra}
                  onChange={event => setGeneroRegra(event.target.value)}
                >
                  <option value="mulher">Mulher (15% até 80 corridas; 13% acima de 80)</option>
                  <option value="outro">Demais / não informado (15%)</option>
                </select>
                <button type="submit">Cadastrar motorista</button>
              </form>
            </section>

            <section className="painel painel-formulario">
              <div className="titulo-painel">
                <span className="numero-etapa numero-etapa-laranja">02</span>
                <div><h2>Registrar corrida</h2><p>Associe uma corrida ao motorista e à data.</p></div>
              </div>
              <form onSubmit={adicionarCorrida} className="formulario">
                <label htmlFor="motorista-corrida">Motorista</label>
                <select
                  id="motorista-corrida"
                  value={motoristaId}
                  onChange={e => setMotoristaId(e.target.value)}
                  required
                >
                  {motoristas.map(motorista => (
                    <option key={motorista.id} value={motorista.id}>
                      {motorista.nome} — {motorista.comissaoEspecial
                        ? `${motorista.comissao}% especial`
                        : "comissão automática semanal"}
                    </option>
                  ))}
                </select>
                <label htmlFor="valor-corrida">Valor da corrida</label>
                <div className="campo-valor">
                  <span aria-hidden="true">R$</span>
                  <input
                    id="valor-corrida"
                    type="number"
                    min="0.01"
                    step="0.01"
                    placeholder="0,00"
                    value={valor}
                    onChange={e => setValor(e.target.value)}
                    required
                  />
                </div>
                <label htmlFor="data-corrida">Data da corrida</label>
                <input
                  id="data-corrida"
                  type="date"
                  value={data}
                  onChange={e => setData(e.target.value)}
                  required
                />
                <button type="submit">Adicionar corrida</button>
              </form>
            </section>
          </div>

          <section className="painel painel-importacao">
            <div hidden>
            <>
            <div className="titulo-secao">
              <div>
                <h2>Importar conversas do WhatsApp</h2>
                <p>Selecione um ou mais TXT/ZIP; a prévia permite conferir o lote antes de salvar.</p>
              </div>
              <div className="navegacao-semana" aria-label="Semana do relatório importado">
                <button
                  type="button"
                  className="botao-seta"
                  aria-label="Semana anterior do relatório importado"
                  onClick={() => setSemanaInicio(deslocarDias(semanaInicio, -7))}
                >←</button>
                <strong>{formatarData(semanaInicio)} – {formatarData(semanaFim)}</strong>
                <button
                  type="button"
                  className="botao-seta"
                  aria-label="Próxima semana do relatório importado"
                  onClick={() => setSemanaInicio(deslocarDias(semanaInicio, 7))}
                >→</button>
                <button
                  type="button"
                  className="botao-hoje"
                  onClick={() => setSemanaInicio(inicioDaSemana(hoje))}
                >Semana atual</button>
              </div>
            </div>
            <div className="acoes-importacao">
              <label className="seletor-arquivo" htmlFor="arquivo-whatsapp">
                Conversas exportadas do WhatsApp (.zip ou .txt; selecione várias)
                <input
                  id="arquivo-whatsapp"
                  type="file"
                  accept=".txt,.zip,text/plain,application/zip,application/x-zip-compressed"
                  multiple
                  onChange={importarConversa}
                  disabled={processandoArquivo || Boolean(preImportacao)}
                />
              </label>
              <button
                type="button"
                className="botao-secundario"
                onClick={limparHistoricoImportacao}
              >
              Limpar fechamento da semana
              </button>
            </div>
            <p className="nota-importacao">
              Aceita vários ZIPs/TXTs de uma vez, processados localmente. Arquivos de mídia são
              ignorados; nenhuma conversa é enviada a serviços externos. A análise cria uma prévia:
              corridas sem contexto suficiente, motoristas ambíguos, confirmações e correções
              aguardam conferência antes de entrar nos relatórios.
            </p>
            {processandoArquivo && <p className="mensagem-importacao">Lendo e analisando arquivo…</p>}
            {mensagemImportacao && <p className="mensagem-importacao" role="status">{mensagemImportacao}</p>}
            {resultadoImportacao && (() => {
              const motoristasResultado = normalizarLista(resultadoImportacao.motoristas);
              return (
                <div className="resultado-importacao">
                  <h3>Resultado da importação: {resultadoImportacao.arquivo}</h3>
                  <p>
                    {resultadoImportacao.mensagensAnalisadas} mensagem(ns) analisada(s) ·
                    Motoristas identificados: {motoristasResultado.length > 0
                      ? motoristasResultado.join(", ")
                      : "nenhum"}.
                  </p>
                  {resultadoImportacao.conversas.length > 0 && (
                    <ul>
                      {resultadoImportacao.conversas.map((conversa, index) => {
                        const motoristasConversa = normalizarLista(conversa.motoristas);
                        return (
                          <li key={`${conversa.nome}-${index}`}>
                            <strong>{conversa.nome}</strong>: {conversa.mensagensAnalisadas} mensagem(ns);
                            {conversa.analysisMode === "manual" && " análise manual; "}
                            motoristas: {motoristasConversa.length > 0 ? motoristasConversa.join(", ") : "nenhum"};
                            {` ${conversa.corridasImportadas} corrida(s) adicionada(s), ${conversa.itensConferencia} item(ns) para conferência.`}
                            {conversa.erro && <span className="erro-importacao"> {conversa.erro}</span>}
                            {conversa.periodo && (
                              <div>
                                Período da conversa: {formatarData(conversa.periodo.inicio)} a{" "}
                                {formatarData(conversa.periodo.fim)}.
                              </div>
                            )}
                            {conversa.calculos?.map(calculation => (
                              <div key={`${conversa.nome}-${calculation.start}`}>
                                {formatarData(calculation.start)} a {formatarData(calculation.end)}:
                                {" "}{calculation.count} corrida(s) válida(s), faturamento{" "}
                                {dinheiroComPrefixo(calculation.revenueCents / 100)}, percentual{" "}
                                {calculation.rate}%, comissão Xama{" "}
                                {dinheiroComPrefixo(calculation.commissionCents / 100)}, restante{" "}
                                {dinheiroComPrefixo(calculation.netCents / 100)}.
                                {calculation.pendingReviews > 0 && (
                                  <> {calculation.pendingReviews} item(ns) aguardam conferência e não foram contados.</>
                                )}
                              </div>
                            ))}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {resultadoImportacao.erros.length > 0 && (
                    <div className="erros-importacao">
                      <strong>Erros e avisos</strong>
                      <ul>
                        {resultadoImportacao.erros.map((erro, index) => <li key={`${erro}-${index}`}>{erro}</li>)}
                      </ul>
                    </div>
                  )}
                </div>
              );
            })()}

            {preImportacao && (
              <div className="resultado-importacao">
                <h3>Prévia do lote — ainda não salva</h3>
                <p role="status">
                  {preImportacao.conversations.some(conversation => conversation.analysisMode === "manual")
                    ? "Modo manual ativo: a análise local continua disponível; todos os candidatos aguardam revisão e aprovação."
                    : `IA Luna — ChatGPT 6: ${aiStatus.loading
                    ? "consultando configuração…"
                    : aiStatus.error
                      ? aiStatus.error
                      : !aiStatus.ready
                        ? `não configurada; configure ${aiStatus.missing.join(" e ") || "OPENAI_API_KEY"} no .env.`
                        : aiStatus.connected
                          ? `conectada · ${aiStatus.model} · última chamada concluída com sucesso`
                          : `configurada · ${aiStatus.model} · conexão será verificada na análise real`}`}
                </p>
                <p>
                  {preImportacao.arquivos.length} arquivo(s),{" "}
                  {preImportacao.conversations.length} conversa(s),{" "}
                  {preImportacao.conversations.reduce((sum, item) => sum + item.candidatos.length, 0)}{" "}
                  item(ns) analisado(s). Confirme os motoristas antes de salvar.
                </p>
                {preImportacao.errors.length > 0 && (
                  <div className="erros-importacao">
                    <strong>Falhas individuais (os demais arquivos continuaram)</strong>
                    <ul>
                      {preImportacao.errors.map((error, index) => (
                        <li key={`${error.arquivo}-${index}`}>{error.arquivo}: {error.mensagem}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {preImportacao.conversations.map(conversation => (
                  <div className="tabela-wrap" key={conversation.id}>
                    <strong>{conversation.arquivo} / {conversation.arquivoConversa}</strong>
                    <span> · {conversation.mensagensAnalisadas} mensagem(ns)</span>
                    {conversation.erro && <p className="erro-importacao">{conversation.erro}</p>}
                    {conversation.aviso && <p className="nota-importacao">{conversation.aviso}</p>}
                    {conversation.analysisMode === "manual" && (
                      <>
                        <p className="nota-importacao">
                          Análise local sem IA. Motivo: {conversation.manualFailureReason}.
                          Revise cada item; nenhum entra no fechamento antes da aprovação manual.
                        </p>
                        {conversation.mensagens?.length > 0 && (
                          <details>
                            <summary>Ver mensagens preservadas ({conversation.mensagens.length})</summary>
                            <ul>
                              {conversation.mensagens.map((message, index) => (
                                <li key={`${conversation.id}-message-${index}`}>
                                  {message.date} {message.time} · {message.sender}: {message.body}
                                </li>
                              ))}
                            </ul>
                          </details>
                        )}
                      </>
                    )}
                    {!conversation.erro && (
                      <p>
                        Identificação: {conversation.motorista.method}
                        {conversation.motorista.driverName ? ` — ${conversation.motorista.driverName}` : " — pendente"}
                      </p>
                    )}
                   {conversation.aiSummary && (
  <p>
    IA {conversation.aiSummary.model}: {conversation.aiSummary.confirmed} confirmada(s),{" "}
    {conversation.aiSummary.cancelled} cancelada(s), {conversation.aiSummary.pending} pendente(s),{" "}
    {conversation.aiSummary.unclassified} grupo(s) sem corrida identificada ·{" "}
    faturamento confirmado{" "}
    {dinheiroComPrefixo(conversation.aiSummary.confirmedRevenueCents / 100)}.
  </p>
)}

{conversation.aiFareAudit?.length > 0 && (
  <details className="xama-ai-audit">
    <summary>
      Auditoria inteligente: {conversation.aiFareAudit.length} mensagem(ns) com valor sem corrida vinculada
    </summary>
    <p>
      Estas mensagens não foram contabilizadas. Confira se representam
      corridas que a primeira análise não identificou. Nenhuma será
      aprovada automaticamente.
    </p>
    <ul>
      {conversation.aiFareAudit.map((item, index) => (
        <li key={`${conversation.id}-fare-audit-${item.messageIndex}-${index}`}>
          {item.date} {item.time} · {item.sender} ·{" "}
          {dinheiroComPrefixo(item.amountCents / 100)} — {item.body}
        </li>
      ))}
    </ul>
  </details>
)}
                    {conversation.aiUnclassified?.length > 0 && (
                      <details>
                        <summary>
                          Ver mensagens sem corrida identificada ({conversation.aiUnclassified.length} grupo(s))
                        </summary>
                        {conversation.aiUnclassified.map((group, index) => (
                          <div key={`${conversation.id}-unclassified-${index}`}>
                            <strong>{group.reason}</strong>
                            <ul>
                              {group.messages.map((message, messageIndex) => (
                                <li key={`${message.date}-${message.time}-${messageIndex}`}>
                                  {message.date} {message.time} · {message.sender}: {message.body}
                                </li>
                              ))}
                            </ul>
                          </div>
                        ))}
                      </details>
                    )}
                    <label>
                      Motorista da conversa
                      <select
                        value={conversation.motorista.driverId ?? ""}
                        onChange={event => alterarMotoristaPreImportacao(conversation.id, event.target.value)}
                        aria-label={`Motorista para ${conversation.arquivoConversa}`}
                      >
                        <option value="">Não identificado — revisão manual</option>
                        {motoristas.map(driver => (
                          <option key={driver.id} value={driver.id}>{driver.nome}</option>
                        ))}
                      </select>
                    </label>
                    {conversation.candidatos.length > 0 && (
                      <div className="tabela">
                        <table>
                          <thead>
                            <tr><th>Data/hora</th><th>Remetente e mensagem</th><th>Valor</th><th>Classificação</th><th>Destino</th></tr>
                          </thead>
                          <tbody>
                            {conversation.candidatos.map(candidate => {
                              const driver = motoristas.find(item => (
                                String(item.id) === String(conversation.motorista.driverId)
                              ));
                              const reviewReason = candidate.reviewReason
                                ?? (!driver ? "Motorista não identificado" : null);
                              return (
                                <tr key={candidate.id}>
                                  <td>{formatarData(candidate.date)} {candidate.time}</td>
                                  <td className="texto-mensagem">{candidate.sender}: {candidate.text}</td>
                                  <td>{candidate.amountCents === null
                                    ? "Não identificado"
                                    : dinheiroComPrefixo(candidate.amountCents / 100)}</td>
                                  <td>{reviewReason ?? "Corrida identificada"}</td>
                                  <td>{reviewReason ? "Revisão manual" : "Importação após confirmar"}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                ))}
                <div className="acoes-importacao">
                  <button
                    type="button"
                    onClick={confirmarPreImportacao}
                    disabled={!preImportacao.conversations.some(conversation => (
                      !conversation.duplicada
                      && (conversation.analysisMode === "manual"
                        || conversation.candidatos.length > 0
                        || conversation.motorista.driverId)
                    ))}
                  >
                    {preImportacao.conversations.some(conversation => conversation.analysisMode === "manual")
                      ? "Salvar para conferência manual"
                      : "Confirmar importação e salvar"}
                  </button>
                  <button type="button" className="botao-secundario" onClick={() => setPreImportacao(null)}>
                    Cancelar prévia
                  </button>
                </div>
              </div>
            )}
            </>
            </div>

            <section className="tabela-wrap modulo-conferencia">
              <div className="cabecalho-conferencia">
                <div>
                  <h3>Conferência de importações</h3>
                  <p>
                    {revisoesConferencia.length} mensagem(ns) pendente(s) ·{" "}
                    {corridasValidasEmLote.length} corrida(s) válida(s) para aprovação em lote
                  </p>
                </div>
                <div className="controles-conferencia">
                  {conferenciaExpandida && (
                    <>
                      <label>
                        Importação
                        <select
                          value={filtroImportacaoRevisao}
                          onChange={event => {
                            setFiltroImportacaoRevisao(event.target.value);
                            setPaginaRevisoes(0);
                          }}
                        >
                          <option value="">Todas as importações</option>
                          {importacoes.map(item => (
                            <option key={item.assinatura} value={item.assinatura}>
                              {item.arquivoConversa ?? item.nome}
                              {item.importadoEm
                                ? ` · ${new Date(item.importadoEm).toLocaleString("pt-BR")}`
                                : ""}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Motorista
                        <select
                          value={filtroMotoristaRevisao}
                          onChange={event => {
                            setFiltroMotoristaRevisao(event.target.value);
                            setPaginaRevisoes(0);
                          }}
                        >
                          <option value="">Selecione</option>
                          {motoristas.map(driver => (
                            <option key={driver.id} value={driver.id}>{driver.nome}</option>
                          ))}
                        </select>
                      </label>
                      <button
                        type="button"
                        onClick={aprovarCorridasValidasEmLote}
                        disabled={!filtroImportacaoRevisao || !filtroMotoristaRevisao || corridasValidasEmLote.length === 0}
                      >
                        APROVAR TODAS AS CORRIDAS VÁLIDAS ({corridasValidasEmLote.length})
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    className="botao-secundario"
                    onClick={limparHistoricoImportacao}
                  >
                    Limpar fechamento da semana
                  </button>
                  <button
                    type="button"
                    className="botao-secundario botao-recolher-conferencia"
                    aria-expanded={conferenciaExpandida}
                    aria-label={conferenciaExpandida ? "Ocultar histórico" : "Ver histórico"}
                    onClick={() => setConferenciaExpandida(expanded => !expanded)}
                  >
                    {conferenciaExpandida ? "Ocultar histórico" : "Ver histórico"}
                  </button>
                </div>
              </div>
              {conferenciaExpandida && (
                revisoesConferencia.length > 0 ? (
                  <>
                    <div className="tabela">
                      <table>
                        <thead>
                          <tr><th>Data/hora</th><th>Mensagem</th><th>Motorista</th><th>Valor confirmado</th><th>Ações</th></tr>
                        </thead>
                        <tbody>
                          {revisoesImportacaoPagina.map(revisao => (
                        <tr key={revisao.id}>
                          <td>{formatarData(revisao.date)} {revisao.time || ""}</td>
                          <td className="texto-mensagem">{revisao.text}</td>
                          <td>
                            <select
                              value={revisao.driverIdRevisao}
                              onChange={event => alterarRevisaoImportacao(revisao.id, "driverIdRevisao", event.target.value)}
                              aria-label="Motorista identificado"
                              disabled={revisao.classification === "sistema"}
                            >
                              <option value="">Selecionar</option>
                              {motoristas.map(motorista => (
                                <option key={motorista.id} value={motorista.id}>{motorista.nome}</option>
                              ))}
                            </select>
                          </td>
                          <td>
                            <input
                              type="number"
                              min="0.01"
                              step="0.01"
                              value={revisao.valorRevisao}
                              onChange={event => alterarRevisaoImportacao(revisao.id, "valorRevisao", event.target.value)}
                              aria-label="Valor confirmado da corrida"
                              disabled={revisao.classification === "sistema"}
                            />
                            <small>{revisao.reviewReason}</small>
                          </td>
                          <td>
                            <div className="acoes-revisao">
                              <button
                                type="button"
                                onClick={() => aprovarRevisao(revisao)}
                                disabled={["confirmação", "sistema"].includes(revisao.classification)}
                              >
                                {revisao.classification === "sistema"
                                  ? "Mensagem de sistema"
                                  : revisao.classification === "cancelamento"
                                  ? "Confirmar cancelamento"
                                  : revisao.classification === "correção"
                                    ? "Aprovar correção"
                                    : "Aprovar corrida"}
                              </button>
                              <button type="button" className="botao-secundario" onClick={() => descartarRevisao(revisao.id)}>Descartar</button>
                            </div>
                          </td>
                        </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className="acoes-importacao">
                      <button
                        type="button"
                        className="botao-secundario"
                        disabled={paginaRevisoesAtual === 0}
                        onClick={() => setPaginaRevisoes(page => Math.max(0, page - 1))}
                      >
                        Anteriores
                      </button>
                      <span>Página {paginaRevisoesAtual + 1} de {Math.max(1, Math.ceil(revisoesConferencia.length / tamanhoPagina))}</span>
                      <button
                        type="button"
                        className="botao-secundario"
                        disabled={(paginaRevisoesAtual + 1) * tamanhoPagina >= revisoesConferencia.length}
                        onClick={() => setPaginaRevisoes(page => page + 1)}
                      >
                        Próximas
                      </button>
                    </div>
                  </>
                ) : (
                  <p className="nota-importacao">
                    Nenhuma mensagem pendente para os filtros selecionados. Importe a lista no cartão do motorista para iniciar uma nova conferência; os dados anteriores permanecem no histórico.
                  </p>
                )
              )}
            </section>

            {exibirSecoesFinanceirasOcultas && (
            <div className="tabela-wrap">
              <div className="cabecalho-relatorio-importacao">
                <h3>Fechamento financeiro semanal</h3>
                <div className="acoes-importacao">
                  <button type="button" className="botao-secundario" onClick={exportarRelatorioImportacao}>
                    Exportar fechamento Excel (CSV)
                  </button>
                  <button type="button" className="botao-secundario" onClick={imprimirRelatorioPdf}>
                    Imprimir / salvar PDF
                  </button>
                </div>
              </div>
              <p className="subtitulo-relatorio">
                {formatarData(semanaInicio)} a {formatarData(semanaFim)} · mulheres: 15% até 79 corridas e 13% a partir de 80; demais: 15%; Lizandra: 10%; percentuais especiais preservados.
              </p>
              {revisoesImportacaoDaSemana.length > 0 && (
                <p className="mensagem-importacao">
                  Relatório parcial: {revisoesImportacaoDaSemana.length} item(ns) desta semana aguardam conferência e podem alterar as contagens e os valores.
                </p>
              )}
              <div className="tabela">
                <table>
                  <thead>
                    <tr>
                      <th>Motorista</th><th>Corridas aprovadas</th><th>Faturamento bruto</th>
                      <th>Percentual</th><th>Comissão à central</th><th>Líquido ao motorista</th>
                      <th>Comissão recebida</th><th>Comissão pendente</th>
                    </tr>
                  </thead>
                  <tbody>
                    {resumoImportacaoSemanal.map(resumoMotorista => (
                      <tr key={resumoMotorista.driver.id}>
                        <td className="celula-motorista">{resumoMotorista.driver.nome}</td>
                        <td>{resumoMotorista.count}</td>
                        <td>{dinheiroComPrefixo(resumoMotorista.revenue)}</td>
                        <td>{resumoMotorista.rate}%</td>
                        <td>{dinheiroComPrefixo(resumoMotorista.commissionDue)}</td>
                        <td>{dinheiroComPrefixo(resumoMotorista.baseDue)}</td>
                        <td>{dinheiroComPrefixo(resumoMotorista.paid)}</td>
                        <td className="celula-destaque">{dinheiroComPrefixo(resumoMotorista.pending)}</td>
                      </tr>
                    ))}
                    <tr className="linha-total-importacao">
                      <td>Total</td>
                      <td>{resumoImportacaoSemanal.reduce((sum, item) => sum + item.count, 0)}</td>
                      <td>{dinheiroComPrefixo(faturamentoImportadoDaSemana)}</td>
                      <td>—</td>
                      <td>{dinheiroComPrefixo(comissaoImportadaDaSemana)}</td>
                      <td>{dinheiroComPrefixo(resumoImportacaoSemanal.reduce((sum, item) => sum + item.baseDue, 0))}</td>
                      <td>{dinheiroComPrefixo(resumoImportacaoSemanal.reduce((sum, item) => sum + item.paid, 0))}</td>
                      <td>{dinheiroComPrefixo(resumoImportacaoSemanal.reduce((sum, item) => sum + item.pending, 0))}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              {importacoes.length > 0 && (
                <>
                  <p className="nota-importacao">
                    Conversas registradas: {importacoes
                      .map(importacao => `${importacao.nome} / ${importacao.arquivoConversa ?? importacao.nome}`)
                      .join(", ")}.
                    Corridas importadas: {corridasImportadas.length}.
                  </p>
                  {importacoes.filter(importacao => (
                    importacao.analysisMode === "manual" && Array.isArray(importacao.mensagens)
                  )).map(importacao => (
                    <details key={`${importacao.assinatura}-mensagens`}>
                      <summary>
                        Mensagens preservadas em modo manual — {importacao.arquivoConversa}
                        {" "}({importacao.mensagens.length})
                      </summary>
                      <ul>
                        {importacao.mensagens.map((message, index) => (
                          <li key={`${importacao.assinatura}-${index}`}>
                            {message.date} {message.time} · {message.sender}: {message.body}
                          </li>
                        ))}
                      </ul>
                    </details>
                  ))}
                </>
              )}
              {corridasImportadas.length > 0 && (
                <div className="tabela-wrap">
                  <h3>Corridas importadas</h3>
                  <div className="tabela">
                    <table>
                      <thead>
                        <tr><th>Data/hora</th><th>Motorista</th><th>Valor</th><th>Referência</th><th>Arquivo</th></tr>
                      </thead>
                      <tbody>
                        {corridasImportadasPagina.map(corrida => (
                          <tr key={corrida.id}>
                            <td>{formatarData(corrida.date)} {corrida.time || ""}</td>
                            <td>{motoristas.find(motorista => motorista.id === corrida.driverId)?.nome ?? corrida.driverName}</td>
                            <td>{dinheiroComPrefixo(corrida.amount)}</td>
                            <td>{corrida.hasTripId ? corrida.identity.replace("trip:", "") : "Mensagem"}</td>
                            <td>{corrida.arquivo}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {corridasImportadas.length > tamanhoPagina && (
                    <div className="acoes-importacao">
                      <button
                        type="button"
                        className="botao-secundario"
                        disabled={paginaCorridasImportadasAtual === 0}
                        onClick={() => setPaginaCorridasImportadas(page => Math.max(0, page - 1))}
                      >
                        Anteriores
                      </button>
                      <span>Página {paginaCorridasImportadasAtual + 1} de {Math.ceil(corridasImportadas.length / tamanhoPagina)}</span>
                      <button
                        type="button"
                        className="botao-secundario"
                        disabled={(paginaCorridasImportadasAtual + 1) * tamanhoPagina >= corridasImportadas.length}
                        onClick={() => setPaginaCorridasImportadas(page => page + 1)}
                      >
                        Próximas
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
            )}
          </section>

          <XamaLayout
            drivers={motoristas.map(motorista => {
              const totals = calculateDriverPeriodTotals(
                todasCorridas,
                motorista,
                motorista.periodStart,
                motorista.periodEnd,
              );
              return {
                ...motorista,
                trips: totals.count,
                gross: totals.revenueCents / 100,
                rate: totals.rate ?? "Variável",
                manualRateValue: totals.rate ?? automaticCommission(motorista, 0),
                commission: totals.commissionCents / 100,
                net: totals.netCents / 100,
              };
            })}
            summary={resumoGeralDoPeriodo}
            periodStart={resumoInicio}
            periodEnd={resumoFim}
            periodLabel={`${formatarData(resumoInicio)} – ${formatarData(resumoFim)}`}
            onSummaryPeriodChange={alterarPeriodoResumo}
            onNameChange={salvarNomeMotorista}
            onCommissionChange={alterarComissao}
            onCommissionModeChange={alterarModoComissao}
            onGenderChange={alterarRegraDeGenero}
            onTelephoneChange={alterarTelefoneMotorista}
            onAliasesChange={alterarAliasesMotorista}
            onDriverPeriodChange={alterarPeriodoMotorista}
            onImportFile={importarConversa}
            onClearImport={limparImportacaoMotorista}
            onConfirmImport={confirmarPreImportacao}
            onCancelImport={() => {
              const driverId = preImportacao?.motoristaId;
              if (driverId) {
                setMensagensImportacaoMotoristas(previous => ({
                  ...previous,
                  [driverId]: "Prévia cancelada; nenhum dado foi salvo.",
                }));
              }
              setPreImportacao(null);
            }}
            importPreview={preImportacao}
            aiStatus={aiStatus}
            importStatuses={mensagensImportacaoMotoristas}
            isProcessing={processandoArquivo}
            onDelete={excluirMotorista}
          />

          {relatoriosAbertos && (
          <section className="painel fechamento-consolidado">
            <div className="titulo-secao">
              <div>
                <h2>Fechamento consolidado por motorista</h2>
                <p>
                  {formatarData(semanaInicio)} a {formatarData(semanaFim)} · somente corridas válidas
                  e aprovadas entram nos valores.
                </p>
              </div>
              <div className="acoes-importacao">
                <button type="button" className="botao-secundario" onClick={exportarImagemFechamentoGeral}>
                  Baixar imagem PNG
                </button>
                <button type="button" className="botao-secundario" onClick={exportarFechamentoConsolidado}>
                  Exportar fechamento Excel (CSV)
                </button>
              </div>
            </div>
            <div className="indicadores-semana">
              <div><span>Motoristas calculados</span><strong>{resumoFechamento.drivers}</strong></div>
              <div><span>Corridas válidas</span><strong>{resumoFechamento.rides}</strong></div>
              <div><span>Faturamento bruto</span><strong>{dinheiroComPrefixo(resumoFechamento.revenueCents / 100)}</strong></div>
              <div><span>Comissões a receber</span><strong>{dinheiroComPrefixo(resumoFechamento.commissionCents / 100)}</strong></div>
              <div><span>Aguardando processamento</span><strong>{motoristasAguardando}</strong></div>
            </div>
            <div className="tabela">
              <table>
                <thead>
                  <tr>
                    <th>Motorista</th><th>Corridas</th><th>Faturamento bruto</th>
                    <th>Percentual</th><th>Comissão Xama</th><th>Restante</th>
                    <th>Situação</th><th>Relatório</th>
                  </tr>
                </thead>
                <tbody>
                  {fechamentoSemanalPorMotorista.map(item => {
                    const calculation = item.current ? item.calculation : item.preview;
                    const detailRides = item.current ? item.calculation.rides : item.preview.rides;
                    return (
                      <tr key={item.driver.id}>
                        <td className="celula-motorista">
                          {item.driver.nome}
                          {item.revisionCount > 0 && (
                            <span className="percentual-motorista">
                              {item.revisionCount} versão(ões) salva(s)
                            </span>
                          )}
                          {item.pendingReviews > 0 && (
                            <span className="percentual-motorista">
                              {item.pendingReviews} item(ns) aguardando revisão
                            </span>
                          )}
                        </td>
                        <td>{calculation.count}</td>
                        <td>{dinheiroComPrefixo(calculation.revenueCents / 100)}</td>
                        <td>{calculation.rate}%</td>
                        <td className="celula-destaque">{dinheiroComPrefixo(calculation.commissionCents / 100)}</td>
                        <td>{dinheiroComPrefixo(calculation.netCents / 100)}</td>
                        <td>{item.status}</td>
                        <td>
                          <button
                            type="button"
                            className="botao-secundario"
                            disabled={calculation.count === 0}
                            onClick={() => abrirRelatorioMotorista(item.driver.id)}
                          >
                            Ver / imprimir
                          </button>
                          {detailRides.length > 0 && (
                            <details>
                              <summary>Corridas ({detailRides.length})</summary>
                              <div className="tabela">
                                <table>
                                  <thead><tr><th>Data</th><th>Horário</th><th>Valor</th><th>Origem</th></tr></thead>
                                  <tbody>
                                    {detailRides.map(ride => (
                                      <tr key={`${ride.fingerprint}-${ride.amountCents}`}>
                                        <td>{formatarData(ride.date)}</td>
                                        <td>{ride.time || "—"}</td>
                                        <td>{dinheiroComPrefixo(ride.amountCents / 100)}</td>
                                        <td>{ride.source}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </details>
                          )}
                          {item.history.length > 0 && (
                            <details>
                              <summary>Histórico ({item.history.length})</summary>
                              <ul>
                                {item.history.map(version => (
                                  <li key={version.id}>
                                    Versão {version.revision}: {version.count} corrida(s),{" "}
                                    {dinheiroComPrefixo(version.revenueCents / 100)} brutos,{" "}
                                    {version.rate}% · comissão{" "}
                                    {dinheiroComPrefixo(version.commissionCents / 100)}
                                    {version.calculatedAt && (
                                      <> · {formatarData(version.calculatedAt.slice(0, 10))} {version.calculatedAt.slice(11, 16)}</>
                                    )}
                                    .
                                  </li>
                                ))}
                              </ul>
                            </details>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="nota-importacao">
              As versões anteriores permanecem no histórico. Mensagens pendentes, rejeitadas ou sem
              evidência suficiente não entram no cálculo; esses casos ficam aguardando conferência manual.
            </p>
          </section>
          )}

          {relatoriosAbertos && (
          <section className="painel painel-semanal">
            <div className="cabecalho-semanal">
              <div>
                <span className="sobretitulo">FECHAMENTO OPERACIONAL</span>
                <h2>Resumo semanal</h2>
                <p>Período de segunda-feira a domingo</p>
              </div>
              <div className="navegacao-semana" aria-label="Navegação de semanas">
                <button
                  type="button"
                  className="botao-seta"
                  aria-label="Ver semana anterior"
                  onClick={() => setSemanaInicio(deslocarDias(semanaInicio, -7))}
                >←</button>
                <strong>{formatarData(semanaInicio)} – {formatarData(semanaFim)}</strong>
                <button
                  type="button"
                  className="botao-seta"
                  aria-label="Ver próxima semana"
                  onClick={() => setSemanaInicio(deslocarDias(semanaInicio, 7))}
                >→</button>
                <button
                  type="button"
                  className="botao-hoje"
                  onClick={() => setSemanaInicio(inicioDaSemana(hoje))}
                >Semana atual</button>
              </div>
            </div>
            <div className="indicadores-semana">
              <div><span>Corridas na semana</span><strong>{corridasDaSemana.length}</strong></div>
              <div><span>Faturamento semanal</span><strong>{dinheiroComPrefixo(faturamentoDaSemana)}</strong></div>
              <div><span>Comissões semanais</span><strong>{dinheiroComPrefixo(comissoesDaSemana)}</strong></div>
            </div>
            <div className="grafico-painel">
              <div className="cabecalho-grafico">
                <h3>Faturamento e comissões por dia</h3>
                <span>Valores do período selecionado</span>
              </div>
              <GraficoSemanal dias={diasDaSemana} dinheiro={dinheiroComPrefixo} />
            </div>
            {relatoriosAbertos && (
            <div className="tabela-wrap">
              <h3>Fechamento por motorista</h3>
              <div className="tabela">
                <table>
                  <thead>
                    <tr><th>Motorista</th><th>Percentual aplicado / especial</th><th>Regra WhatsApp</th><th>Corridas</th><th>Faturamento</th><th>Comissão da central</th><th>Líquido do motorista</th></tr>
                  </thead>
                  <tbody>
                    {motoristas.map(motorista => {
                      const resumoMotorista = resumoDaSemana(motorista);
                      return (
                        <tr key={motorista.id}>
                          <td className="celula-motorista">
                            {motorista.nome}
                            <details>
                              <summary>Identificação WhatsApp</summary>
                              <label>
                                Telefone
                                <input
                                  type="tel"
                                  value={motorista.telefone ?? ""}
                                  onChange={event => alterarTelefoneMotorista(motorista.id, event.target.value)}
                                />
                              </label>
                              <label>
                                Apelidos (separados por vírgula)
                                <input
                                  value={(motorista.aliases ?? []).join(", ")}
                                  onChange={event => alterarAliasesMotorista(motorista.id, event.target.value)}
                                />
                              </label>
                            </details>
                          </td>
                          <td>
                            <input
                              type="number"
                              min="0"
                              max="100"
                              step="0.1"
                              value={motorista.comissaoEspecial
                                ? motorista.comissao
                                : resumoMotorista.percentual}
                              onChange={event => alterarComissao(motorista.id, event.target.value)}
                              className="input-comissao"
                            />
                            <select
                              value={motorista.comissaoEspecial ? "especial" : "automatica"}
                              onChange={event => alterarModoComissao(motorista.id, event.target.value)}
                              aria-label={`Modo de comissão para ${motorista.nome}`}
                            >
                              <option value="automatica">Regra automática</option>
                              <option value="especial">Percentual especial</option>
                            </select>
                          </td>
                          <td>
                            <select
                              value={motorista.generoRegra}
                              onChange={event => alterarRegraDeGenero(motorista.id, event.target.value)}
                              aria-label={`Regra de comissão para ${motorista.nome}`}
                            >
                              <option value="mulher">Mulher</option>
                              <option value="outro">Demais</option>
                            </select>
                          </td>
                          <td>{resumoMotorista.quantidade}</td>
                          <td>{dinheiroComPrefixo(resumoMotorista.faturamento)}</td>
                          <td className="celula-destaque">{dinheiroComPrefixo(resumoMotorista.comissao)}</td>
                          <td>{dinheiroComPrefixo(resumoMotorista.liquido)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
            )}
          </section>
          )}

          {relatoriosAbertos && (
          <section className="painel" id="relatorio-detalhado">
            <div className="titulo-secao">
              <div><h2>Relatório detalhado de corridas</h2><p>Filtros por motorista e período; comissão e líquido calculados por semana.</p></div>
              <div className="acoes-importacao">
                <span className="contador-registros">{corridasRelatorio.length} registro(s)</span>
                <button type="button" className="botao-secundario" onClick={exportarDetalhesCSV}>
                  Exportar detalhes Excel (CSV)
                </button>
                <button type="button" className="botao-secundario" onClick={imprimirRelatorioPdf}>
                  Imprimir / salvar PDF
                </button>
              </div>
            </div>
            <div className="acoes-importacao filtros-relatorio">
              <label>
                Motorista
                <select
                  value={filtroMotoristaRelatorio}
                  onChange={event => setFiltroMotoristaRelatorio(event.target.value)}
                >
                  <option value="">Todos</option>
                  {motoristas.map(driver => <option key={driver.id} value={driver.id}>{driver.nome}</option>)}
                </select>
              </label>
              <label>De <input type="date" value={filtroInicioRelatorio} onChange={event => setFiltroInicioRelatorio(event.target.value)} /></label>
              <label>Até <input type="date" value={filtroFimRelatorio} onChange={event => setFiltroFimRelatorio(event.target.value)} /></label>
            </div>
            <p className="nota-importacao">
              Motorista: {motoristas.find(
                driver => String(driver.id) === filtroMotoristaRelatorio,
              )?.nome ?? "Todos"} · Corridas: {detalhesRelatorio.length} · Faturamento: {dinheiroComPrefixo(reportRevenueCents / 100)} · Comissão da central:{" "}
              {dinheiroComPrefixo(reportCommission)} · Líquido dos motoristas: {dinheiroComPrefixo(reportNet)}.
            </p>
            {detalhesRelatorio.length === 0 ? (
              <div className="vazio">
                <span className="vazio-icone" aria-hidden="true">↗</span>
                <strong>Nenhuma corrida registrada</strong>
                <p>Não há corridas no filtro selecionado.</p>
              </div>
            ) : (
              <div className="tabela">
                <table>
                  <thead><tr><th>Data</th><th>Horário</th><th>Motorista</th><th>Valor</th><th>Percentual</th><th>Comissão central</th><th>Líquido</th><th>Origem</th></tr></thead>
                  <tbody>
                    {detalhesRelatorioPagina.map(ride => (
                      <tr key={`${ride.id}-${ride.data}`}>
                        <td>{formatarData(ride.data)}</td>
                        <td>{ride.time || "—"}</td>
                        <td>{ride.driver?.nome ?? "Motorista não identificado"}</td>
                        <td className="celula-destaque">{dinheiroComPrefixo(ride.amountCents / 100)}</td>
                        <td>{ride.rate}%</td>
                        <td>{dinheiroComPrefixo(ride.commission)}</td>
                        <td>{dinheiroComPrefixo(ride.net)}</td>
                        <td>{ride.arquivo ? "WhatsApp" : "Manual"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {corridasRelatorio.length > tamanhoPagina && (
              <div className="acoes-importacao">
                <button
                  type="button"
                  className="botao-secundario"
                  disabled={paginaRelatorioAtual === 0}
                  onClick={() => setPaginaRelatorio(page => Math.max(0, page - 1))}
                >
                  Anteriores
                </button>
                <span>Página {paginaRelatorioAtual + 1} de {Math.ceil(corridasRelatorio.length / tamanhoPagina)}</span>
                <button
                  type="button"
                  className="botao-secundario"
                  disabled={(paginaRelatorioAtual + 1) * tamanhoPagina >= corridasRelatorio.length}
                  onClick={() => setPaginaRelatorio(page => page + 1)}
                >
                  Próximas
                </button>
              </div>
            )}
          </section>
          )}
        </>
      )}

      {abaAtiva === "carteira" && (
        <section className="painel painel-carteira">
          <div className="cabecalho-semanal">
            <div>
              <span className="sobretitulo">CARTEIRA FINANCEIRA</span>
              <h2>Resumo da base</h2>
              <p>Saldo, pagamentos, comissões e histórico da semana selecionada.</p>
            </div>
            <div className="navegacao-semana" aria-label="Navegação financeira pela semana">
              <button
                type="button"
                className="botao-seta"
                aria-label="Ver semana anterior da carteira"
                onClick={() => setSemanaInicio(deslocarDias(semanaInicio, -7))}
              >←</button>
              <strong>{formatarData(semanaInicio)} – {formatarData(semanaFim)}</strong>
              <button
                type="button"
                className="botao-seta"
                aria-label="Ver próxima semana da carteira"
                onClick={() => setSemanaInicio(deslocarDias(semanaInicio, 7))}
              >→</button>
              <button
                type="button"
                className="botao-hoje"
                onClick={() => setSemanaInicio(inicioDaSemana(hoje))}
              >Semana atual</button>
            </div>
          </div>

          <div className="cards-carteira">
            <article className="cartao-carteira">
              <span>Saldo disponível</span>
              <strong>{dinheiroComPrefixo(saldoDisponivel)}</strong>
            </article>
            <article className="cartao-carteira">
              <span>Faturamento semanal da base</span>
              <strong>{dinheiroComPrefixo(faturamentoDaSemana)}</strong>
            </article>
            <article className="cartao-carteira">
              <span>Comissões recebidas</span>
              <strong>{dinheiroComPrefixo(comissoesRecebidasSemana)}</strong>
            </article>
            <article className="cartao-carteira">
              <span>Comissões pendentes</span>
              <strong>{dinheiroComPrefixo(comissoesPendentesSemana)}</strong>
            </article>
          </div>

          <div className="painel-grid-carteira">
            <form className="formulario formulario-carteira" onSubmit={adicionarPagamento}>
              <div className="titulo-painel titulo-painel-inline">
                <span className="numero-etapa">03</span>
                <div><h2>Registrar pagamento</h2><p>Registrar valores e confirmar o status.</p></div>
              </div>
              <label htmlFor="motorista-pagamento">Motorista</label>
              <select
                id="motorista-pagamento"
                value={novoPagamento.motoristaId}
                onChange={event => setNovoPagamento(prev => ({ ...prev, motoristaId: event.target.value }))}
              >
                {motoristas.map(motorista => (
                  <option key={motorista.id} value={motorista.id}>{motorista.nome}</option>
                ))}
              </select>
              <label htmlFor="valor-pagamento">Valor pago</label>
              <div className="campo-valor">
                <span aria-hidden="true">R$</span>
                <input
                  id="valor-pagamento"
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={novoPagamento.valor}
                  onChange={event => setNovoPagamento(prev => ({ ...prev, valor: event.target.value }))}
                  required
                />
              </div>
              <label htmlFor="data-pagamento">Data do pagamento</label>
              <input
                id="data-pagamento"
                type="date"
                value={novoPagamento.data}
                onChange={event => setNovoPagamento(prev => ({ ...prev, data: event.target.value }))}
              />
              <label htmlFor="status-pagamento">Status</label>
              <select
                id="status-pagamento"
                value={novoPagamento.status}
                onChange={event => setNovoPagamento(prev => ({ ...prev, status: event.target.value }))}
              >
                <option value="pendente">Pendente</option>
                <option value="confirmado">Confirmado</option>
              </select>
              <button type="submit">Salvar pagamento</button>
            </form>

            <form className="formulario formulario-carteira" onSubmit={adicionarTransacao}>
              <div className="titulo-painel titulo-painel-inline">
                <span className="numero-etapa numero-etapa-laranja">04</span>
                <div><h2>Adicionar ajuste</h2><p>Entradas, saídas ou ajustes manuais no caixa.</p></div>
              </div>
              <label htmlFor="tipo-transacao">Tipo</label>
              <select
                id="tipo-transacao"
                value={novaTransacao.tipo}
                onChange={event => setNovaTransacao(prev => ({ ...prev, tipo: event.target.value }))}
              >
                <option value="entrada">Entrada</option>
                <option value="saida">Saída</option>
                <option value="ajuste">Ajuste</option>
              </select>
              <label htmlFor="valor-transacao">Valor</label>
              <div className="campo-valor">
                <span aria-hidden="true">R$</span>
                <input
                  id="valor-transacao"
                  type="number"
                  step="0.01"
                  value={novaTransacao.valor}
                  onChange={event => setNovaTransacao(prev => ({ ...prev, valor: event.target.value }))}
                  required
                />
              </div>
              <label htmlFor="data-transacao">Data</label>
              <input
                id="data-transacao"
                type="date"
                value={novaTransacao.data}
                onChange={event => setNovaTransacao(prev => ({ ...prev, data: event.target.value }))}
              />
              <label htmlFor="descricao-transacao">Descrição</label>
              <input
                id="descricao-transacao"
                type="text"
                placeholder="Ex.: Reembolso, ajuste de caixa"
                value={novaTransacao.descricao}
                onChange={event => setNovaTransacao(prev => ({ ...prev, descricao: event.target.value }))}
                required
              />
              <button type="submit">Salvar ajuste</button>
            </form>
          </div>

          <div className="tabela-wrap">
            <h3>Pagamentos por motorista</h3>
            <div className="tabela">
              <table>
                <thead>
                  <tr><th>Motorista</th><th>Data</th><th>Valor</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {pagamentos.length === 0 ? (
                    <tr>
                      <td colSpan="4">Nenhum pagamento registrado.</td>
                    </tr>
                  ) : (
                    pagamentos.map(pagamento => {
                      const motorista = motoristas.find(item => item.id === pagamento.motoristaId);
                      return (
                        <tr key={pagamento.id}>
                          <td>{motorista?.nome ?? "Motorista"}</td>
                          <td>{formatarData(pagamento.data)}</td>
                          <td>{dinheiroComPrefixo(pagamento.valor)}</td>
                          <td>
                            <div className="status-pagamento">
                              <select
                                value={pagamento.status}
                                onChange={event => atualizarPagamentoStatus(pagamento.id, event.target.value)}
                              >
                                <option value="pendente">Pendente</option>
                                <option value="confirmado">Confirmado</option>
                              </select>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="tabela-wrap">
            <h3>Extrato financeiro</h3>
            <div className="tabela">
              <table>
                <thead>
                  <tr><th>Data</th><th>Tipo</th><th>Descrição</th><th>Valor</th></tr>
                </thead>
                <tbody>
                  {extratoFinanceiro.length === 0 ? (
                    <tr>
                      <td colSpan="4">Nenhum movimento financeiro registrado.</td>
                    </tr>
                  ) : (
                    extratoFinanceiro.map(item => {
                      const valorExibido = item.tipo === "saida"
                        ? -Math.abs(item.valor)
                        : item.valor;

                      return (
                        <tr key={item.id}>
                          <td>{formatarData(item.data)}</td>
                          <td className={`tipo-valor tipo-valor--${item.tipo}`}>{item.tipo}</td>
                          <td>{item.descricao}</td>
                          <td className={valorExibido >= 0 ? "celula-destaque celula-positive" : "celula-destaque celula-negative"}>
                            {dinheiroComPrefixo(valorExibido)}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      <footer className="rodape">Xama Mobilidade Urbana <span>•</span> Gestão de corridas e motoristas</footer>
    </main>
  );
}