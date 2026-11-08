import "./XamaLayout.css";

function dinheiro(valor) {
  return Number(valor || 0).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

function CartaoMotorista({
  driver,
  onNameChange,
  onCommissionChange,
  onCommissionModeChange,
  onGenderChange,
  onTelephoneChange,
  onAliasesChange,
  onPeriodChange,
  onImportFile,
  onClearImport,
  onConfirmImport,
  onCancelImport,
  importPreview,
  aiStatus,
  importStatus,
  isProcessing,
  onDelete,
}) {
  return (
    <article className="xama-driver-card">
      <div className="xama-driver-name">
        <span>MOTORISTA</span>
        <input
          aria-label={`Nome de ${driver.nome}`}
          defaultValue={driver.nome}
          key={`${driver.id}-${driver.nome}`}
          onBlur={event => {
            const updatedName = event.currentTarget.value.trim();
            if (!updatedName) {
              event.currentTarget.value = driver.nome;
            } else if (updatedName !== driver.nome) {
              onNameChange(driver.id, updatedName);
            }
          }}
          onKeyDown={event => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") event.currentTarget.value = driver.nome;
          }}
        />
        <details>
          <summary>Identificação WhatsApp</summary>
          <label>
            Telefone
            <input
              type="tel"
              value={driver.telefone ?? ""}
              onChange={event => onTelephoneChange(driver.id, event.target.value)}
            />
          </label>
          <label>
            Apelidos (separados por vírgula)
            <input
              value={(driver.aliases ?? []).join(", ")}
              onChange={event => onAliasesChange(driver.id, event.target.value)}
            />
          </label>
        </details>
        <div className="xama-driver-import-actions">
          <label className="xama-file-button">
            <input
              type="file"
              accept=".zip,.txt,text/plain,application/zip,application/x-zip-compressed"
              disabled={isProcessing || Boolean(importPreview)}
              onChange={event => onImportFile(event, driver.id)}
            />
            <span>IMPORTAR LISTA DO WHATSAPP</span>
          </label>
          <button
            type="button"
            className="xama-clear-import"
            disabled={isProcessing || Boolean(importPreview)}
            onClick={() => onClearImport(driver.id)}
          >
            LIMPAR
          </button>
        </div>
        {importStatus && <span className="xama-import-status" role="status">{importStatus}</span>}
        <span className="xama-import-status" role="status">
          {aiStatus.manualFallback
            ? "Última importação analisada localmente; confira os itens antes de aprovar."
            : `IA OpenAI: ${aiStatus.loading
            ? "consultando configuração…"
            : aiStatus.error
              ? aiStatus.error
              : !aiStatus.ready
                ? `não configurada; configure ${aiStatus.missing.join(" e ") || "OPENAI_API_KEY"} no .env.`
                : aiStatus.connected
                  ? `conectada · ${aiStatus.model}`
                  : `configurada · ${aiStatus.model}; conexão ainda não verificada`}`}
        </span>
      </div>

      <div className="xama-driver-data">
        <div className="xama-metrics">
          <div><small>CORRIDAS</small><strong>{driver.trips}</strong></div>
          <div><small>FATURAMENTO BRUTO</small><strong>{dinheiro(driver.gross)}</strong></div>
          <div className="commission-metric">
            <small>
              {driver.rate === "Variável"
                ? "COMISSÃO DA BASE (variável)"
                : `COMISSÃO DA BASE (${driver.rate}%)`}
            </small>
            <strong>{dinheiro(driver.commission)}</strong>
          </div>
        </div>
        <div className="xama-net-row">
          <span>VALOR RESTANTE DO MOTORISTA</span>
          <strong>{dinheiro(driver.net)}</strong>
        </div>
        <div className="xama-date-control">
          <label>
            Data inicial
            <input
              type="date"
              value={driver.periodStart}
              disabled={Boolean(importPreview)}
              onChange={event => onPeriodChange(driver.id, "periodStart", event.target.value)}
            />
          </label>
          <label>
            Data final
            <input
              type="date"
              value={driver.periodEnd}
              disabled={Boolean(importPreview)}
              onChange={event => onPeriodChange(driver.id, "periodEnd", event.target.value)}
            />
          </label>
        </div>
        <div className="xama-driver-settings">
          <label>
            Comissão
            <select
              value={driver.comissaoEspecial ? "especial" : "automatica"}
              onChange={event => onCommissionModeChange(driver.id, event.target.value)}
            >
              <option value="automatica">Regra automática</option>
              <option value="especial">Percentual manual</option>
            </select>
          </label>
          <label>
            Percentual
            <input
              type="number"
              min="0"
              max="100"
              step="0.1"
              value={driver.comissaoEspecial ? driver.comissao : driver.manualRateValue}
              disabled={!driver.comissaoEspecial}
              onChange={event => onCommissionChange(driver.id, event.target.value)}
            />
          </label>
          <label>
            Regra automática
            <select
              value={driver.generoRegra}
              onChange={event => onGenderChange(driver.id, event.target.value)}
            >
              <option value="mulher">Mulher (13% acima de 80 corridas)</option>
              <option value="outro">Demais (15%)</option>
            </select>
          </label>
          <button
            type="button"
            className="xama-delete"
            onClick={() => onDelete(driver.id)}
          >
            Excluir cadastro
          </button>
        </div>
        {importPreview && (
          <div className="xama-import-preview">
            <strong>Prévia da importação · {importPreview.arquivos.join(", ")}</strong>
            <p role="status">
              {importPreview.conversations.some(conversation => conversation.analysisMode === "manual")
                ? "Modo manual ativo: os itens exigem revisão e aprovação antes de entrar no fechamento."
                : `IA OpenAI: ${aiStatus.loading
                ? "consultando configuração…"
                : aiStatus.error
                  ? aiStatus.error
                  : !aiStatus.ready
                    ? `não configurada; configure ${aiStatus.missing.join(" e ") || "OPENAI_API_KEY"} no .env.`
                    : aiStatus.connected
                      ? `conectada · ${aiStatus.model} · última chamada concluída com sucesso`
                      : `configurada · ${aiStatus.model} · conexão será verificada na análise real`}`}
            </p>
            {importPreview.errors.map(error => (
              <p className="erro-importacao" key={`${error.arquivo}-${error.mensagem}`}>
                {error.arquivo}: {error.mensagem}
              </p>
            ))}
            {importPreview.conversations.map(conversation => (
              <div key={conversation.id}>
                <p>
                  {conversation.mensagensAnalisadas} mensagem(ns) analisada(s) ·{" "}
                  {conversation.candidatos.length} item(ns) dentro do período
                  {conversation.foraDoPeriodo
                    ? ` · ${conversation.foraDoPeriodo} fora do período ignorado(s)`
                    : ""}
                  {conversation.erro ? ` · ${conversation.erro}` : ""}
                </p>
                {conversation.analysisMode === "manual" && (
                  <>
                    <p className="nota-importacao">
                      Análise local sem OpenAI ({conversation.manualFailureReason}). Nenhum item será confirmado automaticamente.
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
                {conversation.aiSummary && (
                  <p>
                    IA {conversation.aiSummary.model}: {conversation.aiSummary.confirmed} confirmada(s),{" "}
                    {conversation.aiSummary.cancelled} cancelada(s), {conversation.aiSummary.pending} pendente(s),{" "}
                    {conversation.aiSummary.unclassified} grupo(s) sem corrida identificada ·{" "}
                    faturamento confirmado {dinheiro(conversation.aiSummary.confirmedRevenueCents / 100)}.
                  </p>
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
                {conversation.candidatos.map(candidate => (
                  <div className="xama-import-candidate" key={candidate.id}>
                    <p>
                      {candidate.date} {candidate.time} ·{" "}
                      {candidate.amountCents === null
                        ? "Valor não identificado"
                        : dinheiro(candidate.amountCents / 100)}
                      {" · "}
                      {candidate.classification === "cancelamento"
                        ? "CANCELADA — não contabilizada"
                        : candidate.classification === "correção"
                          ? "CORREÇÃO — pendente"
                          : candidate.reviewReason
                            ? "PENDENTE — não contabilizada"
                            : "CONFIRMADA — após salvar"}
                    </p>
                    <small>{candidate.reviewReason ?? candidate.confirmationSignal ?? "Contexto da corrida concluído"}</small>
                    <small>{candidate.text.slice(0, 240)}{candidate.text.length > 240 ? "…" : ""}</small>
                  </div>
                ))}
              </div>
            ))}
            <div className="xama-preview-actions">
              <button
                type="button"
                disabled={!importPreview.conversations.some(conversation => (
                  !conversation.duplicada
                  && (conversation.analysisMode === "manual"
                    || conversation.candidatos.length > 0
                    || conversation.motorista.driverId)
                ))}
                onClick={onConfirmImport}
              >
                {importPreview.conversations.some(conversation => conversation.analysisMode === "manual")
                  ? "Salvar para conferência manual"
                  : "Confirmar importação"}
              </button>
              <button type="button" className="xama-cancel-preview" onClick={onCancelImport}>
                Cancelar
              </button>
            </div>
          </div>
        )}
      </div>
    </article>
  );
}

export default function XamaLayout({
  drivers,
  summary,
  periodStart,
  periodEnd,
  periodLabel,
  onSummaryPeriodChange,
  onNameChange,
  onCommissionChange,
  onCommissionModeChange,
  onGenderChange,
  onTelephoneChange,
  onAliasesChange,
  onDriverPeriodChange,
  onImportFile,
  onClearImport,
  onConfirmImport,
  onCancelImport,
  importPreview,
  aiStatus,
  importStatuses,
  isProcessing,
  onDelete,
}) {
  return (
    <section className="xama-dashboard" aria-labelledby="xama-summary-title">
      <header className="xama-dashboard-header">
        <div>
          <span className="xama-dashboard-kicker">FECHAMENTO SEMANAL</span>
          <h2 id="xama-summary-title">Resumo por motorista</h2>
          <div className="xama-summary-period">
            <label>
              Data inicial
              <input
                type="date"
                value={periodStart}
                onChange={event => onSummaryPeriodChange("start", event.target.value)}
              />
            </label>
            <label>
              Data final
              <input
                type="date"
                value={periodEnd}
                onChange={event => onSummaryPeriodChange("end", event.target.value)}
              />
            </label>
            <span>Período selecionado: {periodLabel}</span>
          </div>
        </div>
      </header>

      <section className="xama-driver-list" aria-label="Resultados por motorista">
        {drivers.map(driver => (
          <CartaoMotorista
            key={driver.id}
            driver={driver}
            onNameChange={onNameChange}
            onCommissionChange={onCommissionChange}
            onCommissionModeChange={onCommissionModeChange}
            onGenderChange={onGenderChange}
            onTelephoneChange={onTelephoneChange}
            onAliasesChange={onAliasesChange}
            onPeriodChange={onDriverPeriodChange}
            onImportFile={onImportFile}
            onClearImport={onClearImport}
            onConfirmImport={onConfirmImport}
            onCancelImport={onCancelImport}
            importPreview={importPreview?.motoristaId === driver.id ? importPreview : null}
            aiStatus={aiStatus}
            importStatus={importStatuses[driver.id]}
            isProcessing={isProcessing}
            onDelete={onDelete}
          />
        ))}
      </section>

      <section className="xama-summary" aria-label="Totais do período selecionado">
        <h3>RESUMO GERAL DO PERÍODO</h3>
        <div className="xama-summary-grid">
          <div><small>TOTAL DE CORRIDAS</small><strong>{summary.trips}</strong></div>
          <div><small>FATURAMENTO BRUTO</small><strong>{dinheiro(summary.gross)}</strong></div>
          <div><small>COMISSÃO DA BASE</small><strong>{dinheiro(summary.commission)}</strong></div>
          <div><small>VALOR RESTANTE</small><strong>{dinheiro(summary.net)}</strong></div>
        </div>
      </section>
    </section>
  );
}
