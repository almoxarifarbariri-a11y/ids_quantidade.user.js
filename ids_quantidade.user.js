// ==UserScript==
// @name         IDS - Quantidade automática ao bipar
// @namespace    ids-bariri-quantidade
// @version      1.5.0
// @description  Preenche a quantidade ao bipar o código de barras no IDS Saúde (caixa e avulso) + calculadora na transferência. Tabelas lidas do tabelas.json no GitHub.
// @match        https://bariri-saude.ids.inf.br/*
// @grant        none
// @updateURL    https://raw.githubusercontent.com/almoxarifarbariri-a11y/ids_quantidade.user.js/main/ids_quantidade.user.js
// @downloadURL  https://raw.githubusercontent.com/almoxarifarbariri-a11y/ids_quantidade.user.js/main/ids_quantidade.user.js
// ==/UserScript==

(function () {
  // ===== Tabelas (C.B. -> quantidade) vêm do tabelas.json no GitHub =====
  // Para adicionar/alterar um C.B., edite só o tabelas.json: não precisa mexer neste script nem na versão.
  const TABELAS_URL = "https://raw.githubusercontent.com/almoxarifarbariri-a11y/ids_quantidade.user.js/main/tabelas.json";
  const TABELAS_RECARREGAR_MIN = 30;                 // releitura periódica com a página aberta (0 = só ao carregar)
  const TABELAS_CACHE_KEY = "ids-qtd-tabelas-v1";    // cópia local, usada se o GitHub estiver fora do ar

  const TABELA = {};   // etiqueta de caixa: C.B. -> quantidade por embalagem  (chave "caixa" do JSON)
  const AVULSO = {};   // etiqueta avulsa (envelope/cartela) quando NÃO for 1  (chave "avulso" do JSON)
  let tabelasOrigem = "nenhuma";

  function aplicarTabelas(d) {
    for (const k of Object.keys(TABELA)) delete TABELA[k];
    for (const k of Object.keys(AVULSO)) delete AVULSO[k];
    Object.assign(TABELA, d.caixa);
    Object.assign(AVULSO, d.avulso);
  }

  // confere o formato; devolve {caixa, avulso} limpo ou null se o conteúdo não servir
  function validarTabelas(obj) {
    if (!obj || typeof obj !== "object" || !obj.caixa || typeof obj.caixa !== "object") return null;
    const limpar = (o, nome) => {
      const r = {};
      for (const [k, v] of Object.entries(o || {})) {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) r[String(k).trim()] = n;
        else console.warn("[IDS-qtd] tabelas.json: valor inválido ignorado em", nome, k, "=", v);
      }
      return r;
    };
    const caixa = limpar(obj.caixa, "caixa");
    const avulso = limpar(obj.avulso, "avulso");
    if (Object.keys(caixa).length < 10) return null;   // arquivo vazio/quebrado: não troca a tabela atual
    return { caixa, avulso };
  }

  // aceita comentários (// ...) e vírgula sobrando antes de } ou ]
  function lerJsonTolerante(texto) {
    const limpo = texto
      .replace(/^\uFEFF/, "")
      .replace(/\/\/.*$/gm, "")
      .replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(limpo);
  }

  function lerCache() {
    try {
      const s = localStorage.getItem(TABELAS_CACHE_KEY);
      return s ? validarTabelas(JSON.parse(s)) : null;
    } catch (e) { return null; }
  }
  function gravarCache(d) {
    try { localStorage.setItem(TABELAS_CACHE_KEY, JSON.stringify(d)); } catch (e) { /* sem cache, segue */ }
  }

  async function carregarTabelas() {
    try {
      // o parâmetro muda a cada minuto: evita o cache de ~5 min do GitHub
      const url = TABELAS_URL + "?v=" + Math.floor(Date.now() / 60000);
      const r = await fetch(url, { cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const d = validarTabelas(lerJsonTolerante(await r.text()));
      if (!d) throw new Error("conteúdo inválido");
      aplicarTabelas(d);
      gravarCache(d);
      tabelasOrigem = "GitHub";
      console.log("[IDS-qtd] tabelas atualizadas do GitHub | caixa:", Object.keys(TABELA).length,
                  "| avulsos especiais:", Object.keys(AVULSO).length);
    } catch (e) {
      console.warn("[IDS-qtd] não consegui ler o tabelas.json (" + (e && e.message ? e.message : e) +
                   "). Mantendo as tabelas de:", tabelasOrigem, "| caixa:", Object.keys(TABELA).length);
    }
  }

  // 1) cópia local (instantânea)  2) busca no GitHub  3) repete de tempos em tempos
  const cacheInicial = lerCache();
  if (cacheInicial) { aplicarTabelas(cacheInicial); tabelasOrigem = "cópia local"; }
  carregarTabelas();
  if (TABELAS_RECARREGAR_MIN > 0) setInterval(carregarTabelas, TABELAS_RECARREGAR_MIN * 60000);

  const INTERVALO_MS = 30;          // frequência de checagem
  const MIN_MESMO_ITEM_MS = 250;    // espera mínima ao bipar o mesmo item de novo
  const LIMITE_MS = 3000;           // desiste depois disso
  const CONFERE_MS = 400;           // reconfere se o IDS não sobrescreveu
  const VOLTAR_AO_CODIGO_NA_SAIDA = false;  // true = também volta ao código na saída
  const EXIGIR_CAMPO_LIMPO = true;  // ao bipar o MESMO item de novo, só soma depois que o IDS limpar o campo do código

  // Etiqueta avulsa: começa com 0 (gerada pelo IDS, mesmo C.B. da caixa) ou 999 (sistema antigo)
  const QTD_AVULSO = 1;             // quantidade por bipada de etiqueta avulsa que não esteja na AVULSO
  const ehEtiquetaAvulsa = (codigo) => /^(0|999)\d+$/.test(codigo);

  console.log("[IDS-qtd] script carregado v1.1.0 | tabelas:", tabelasOrigem, "| caixa:", Object.keys(TABELA).length,
              "| avulsos especiais:", Object.keys(AVULSO).length);

  // aviso rápido no canto da tela com o que o script entendeu da última bipada
  const aviso = document.createElement("div");
  aviso.style.cssText = "position:fixed;top:6px;right:150px;z-index:2147483000;padding:4px 10px;" +
    "border-radius:6px;font:bold 13px Arial;color:#fff;pointer-events:none;display:none;" +
    "box-shadow:0 1px 4px rgba(0,0,0,.4)";
  document.body.appendChild(aviso);
  let tAviso = null;
  function mostrarAviso(texto, avulso) {
    aviso.textContent = texto;
    aviso.style.background = avulso ? "#e67e00" : "#2e7d32";
    aviso.style.display = "block";
    clearTimeout(tAviso);
    tAviso = setTimeout(() => { aviso.style.display = "none"; }, 3000);
  }

  function campoPorRotulo(regex) {
    const rotulo = [...document.querySelectorAll("label")]
      .filter(l => l.offsetParent !== null)
      .find(l => regex.test(l.textContent.trim().replace(/\s+/g, " ")));
    return rotulo ? document.getElementById(rotulo.getAttribute("for")) : null;
  }

  const RE_COD     = /^C.d\. Barras do Lote:$/;
  const RE_LOTE    = /^Lote do Fabricante:$/;
  const RE_QTD     = /^Quantidade:$/;
  const RE_QTD_REQ = /^Quantidade Requerida:$/;   // só existe na transferência

  function lerQtd() {
    const q = campoPorRotulo(RE_QTD);
    return q ? parseFloat((q.value || "").replace(",", ".")) || 0 : 0;
  }

  function preencher(campo, valor) {
    const cmp = window.Ext && Ext.getCmp(campo.dataset.componentid);
    if (cmp && cmp.setValue) {
      cmp.setValue(valor);
      if (cmp.checkChange) cmp.checkChange();
    } else {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(campo, valor);
      campo.dispatchEvent(new Event("input", { bubbles: true }));
      campo.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  function voltarAoCodigo(qtdCampo) {
    const transferencia = !!campoPorRotulo(RE_QTD_REQ);
    if (!transferencia && !VOLTAR_AO_CODIGO_NA_SAIDA) return;
    const cod = campoPorRotulo(RE_COD);
    const ativo = document.activeElement;
    if (cod && (ativo === qtdCampo || ativo === document.body)) cod.focus();
  }

  // procura a quantidade na tabela usando várias chaves, na ordem; devolve undefined se não achar
  function buscar(tabela, chaves) {
    for (const k of chaves) {
      if (k && tabela[k] !== undefined) return tabela[k];
    }
    return undefined;
  }

  // ===== Calculadora (SÓ na transferência) =====
  const CALC_ATIVA = true;                 // false desliga a calculadora
  const CALC_FOCAR = true;                 // true = o cursor já cai no campo da calculadora
  const CALC_PARA_DESCONHECIDOS = true;    // true = abre também quando o código não está na tabela (você digita a quantidade)
  let calcUnidade = 0;

  const GRAVAR_AUTOMATICO = true;   // true = clica em "Gravar e Incluir" ao dar Enter na calculadora
  const GRAVAR_ESPERA_MS = 150;     // espera o IDS registrar a quantidade antes de clicar
  const RE_BTN_GRAVAR = /^\s*Gravar e Incluir\s*$/i;

  function clicarGravarEIncluir(janela) {
    const acha = (raiz) => [...raiz.querySelectorAll(".x-btn")]
      .find(b => b.offsetParent !== null && RE_BTN_GRAVAR.test(b.textContent));
    const btn = (janela && acha(janela)) || acha(document);
    if (!btn) { console.warn("[IDS-qtd] botão Gravar e Incluir não encontrado"); return false; }
    console.log("[IDS-qtd] clicando em Gravar e Incluir");
    const cmp = window.Ext && Ext.getCmp(btn.id);
    if (cmp && cmp.fireHandler) cmp.fireHandler(); else btn.click();
    return true;
  }

  const calc = document.createElement("div");
  calc.style.cssText = "position:fixed;top:60px;left:60px;z-index:2147483000;padding:8px 10px;" +
    "border-radius:8px;background:#1f2937;color:#fff;font:bold 14px Arial;" +
    "box-shadow:0 2px 8px rgba(0,0,0,.5);display:none;align-items:center;gap:8px";
  calc.innerHTML = '<span class="calc-rot">Caixas:</span>' +
    '<input type="text" inputmode="numeric" maxlength="4" style="width:55px;font:bold 14px Arial;text-align:center">' +
    '<span class="calc-res"></span>';
  document.body.appendChild(calc);
  const calcInput = calc.querySelector("input");
  const calcRes = calc.querySelector(".calc-res");
  const calcRot = calc.querySelector(".calc-rot");

  function fecharCalculadora() { calc.style.display = "none"; calcInput.value = ""; calcUnidade = 0; }

  // posiciona logo abaixo da janela do item (ou perto do campo Quantidade, se não achar a janela)
  function posicionarCalculadora() {
    const q = campoPorRotulo(RE_QTD);
    if (!q) return;
    const janela = q.closest(".x-window");
    const r = (janela || q).getBoundingClientRect();
    calc.style.left = Math.max(8, r.left) + "px";
    calc.style.top = (janela ? r.bottom + 8 : r.bottom + 6) + "px";
  }

  // unidade = quanto vale 1 (caixa, cartela, envelope ou unidade); avulso = true quando a etiqueta é avulsa
  function mostrarCalculadora(unidade, avulso) {
    if (!CALC_ATIVA) return;
    if (!campoPorRotulo(RE_QTD_REQ)) return;       // só existe na transferência
    calcUnidade = unidade;
    calcInput.value = "";
    calcRot.textContent = avulso ? "Avulsos:" : (unidade === 1 ? "Qtd:" : "Caixas:");
    calcRes.textContent = "× " + unidade;
    posicionarCalculadora();
    calc.style.display = "flex";
    if (CALC_FOCAR) calcInput.focus();
  }

  calcInput.addEventListener("input", () => {
    calcInput.value = calcInput.value.replace(/\D/g, "");
    const n = parseInt(calcInput.value, 10);
    calcRes.textContent = "× " + calcUnidade + (n ? " = " + (n * calcUnidade) : "");
  });

  calcInput.addEventListener("keydown", (e) => {
    e.stopPropagation();                            // o Ext não deve reagir a Enter/Esc daqui
    if (e.key === "Escape") { fecharCalculadora(); focarCodigo(); return; }
    if (e.key !== "Enter") return;
    e.preventDefault();
    const n = parseInt(calcInput.value, 10);
    const qtdCampo = campoPorRotulo(RE_QTD);
    const janela = qtdCampo ? qtdCampo.closest(".x-window") : null;
    let gravar = false;
    if (n > 0 && qtdCampo) {
      const total = n * calcUnidade;
      preencher(qtdCampo, total);
      mostrarAviso(n + " × " + calcUnidade + " = " + total, false);
      gravar = GRAVAR_AUTOMATICO;
    }
    fecharCalculadora();
    if (gravar) {
      setTimeout(() => {
        clicarGravarEIncluir(janela);
        setTimeout(focarCodigo, 200);               // devolve o foco ao código para a próxima bipada
      }, GRAVAR_ESPERA_MS);
    } else {
      focarCodigo();
    }
  });

  // some sozinha se a janela do item for fechada; acompanha a janela se ela se mexer
  setInterval(() => {
    if (calc.style.display === "none") return;
    if (!campoPorRotulo(RE_QTD)) fecharCalculadora(); else posicionarCalculadora();
  }, 500);

  // ===== Confirmação do IDS: "medicamento controlado ... prazo mínimo recomendado de N dias" =====
  // Aparece ao bipar de novo o MESMO item (soma): o IDS calcula a suficiência com a quantidade já somada
  // (Dose Diária vazia = 1 por dia) e acha que "ainda há quantidade suficiente". Responder "Sim" abre a
  // janela "Justificativa", e ela pode repetir várias vezes; "Não" apaga o item da linha.
  //
  // SOMAR_REBIPADA_SEM_IDS = true  -> na SAÍDA, quando você bipa de novo o MESMO código do item que já está
  //                                   na tela (quantidade já preenchida), o script soma a quantidade sozinho e
  //                                   NÃO deixa o Enter chegar ao IDS. Assim a pergunta nem aparece.
  //                                   A primeira bipada de cada item continua passando normalmente pelo IDS.
  //                                   Não vale na transferência. false = volta ao comportamento anterior.
  const SOMAR_REBIPADA_SEM_IDS = true;
  // AUTO_CONFIRMAR_SOMA = true -> clica em "Sim" sozinho (NÃO recomendado: abre a Justificativa).
  const AUTO_CONFIRMAR_SOMA = false;
  const RE_JANELA_CONFIRM = /Confirma..o/i;
  const RE_TEXTO_PRAZO = /medicamento controlado[\s\S]*prazo m.nimo/i;
  let ultimaBipada = { codigo: "", t: 0, soma: false };

  function janelaConfirmacaoPrazo() {
    return [...document.querySelectorAll(".x-window")].find(w =>
      w.offsetParent !== null &&
      RE_JANELA_CONFIRM.test((w.querySelector(".x-window-header, .x-header, .x-title")?.textContent || "")) &&
      RE_TEXTO_PRAZO.test(w.textContent || ""));
  }

  let confirmTratada = false;
  setInterval(() => {
    try {
      const w = janelaConfirmacaoPrazo();
      if (!w) { confirmTratada = false; return; }
      if (confirmTratada) return;
      confirmTratada = true;                          // trata cada janela uma única vez
      const ehSoma = ultimaBipada.soma && (Date.now() - ultimaBipada.t) < 4000;
      if (!AUTO_CONFIRMAR_SOMA || !ehSoma) {
        console.log("[IDS-qtd] confirmação de prazo mínimo: aguardando você responder (soma:", ehSoma, ")");
        return;
      }
      const btn = [...w.querySelectorAll(".x-btn")].find(b => /^\s*Sim\s*$/i.test(b.textContent));
      if (!btn) { confirmTratada = false; return; }   // botão ainda não apareceu: tenta de novo
      console.log("[IDS-qtd] confirmação de prazo mínimo na soma do mesmo item: clicando em Sim");
      const cmp = window.Ext && Ext.getCmp(btn.id);
      if (cmp && cmp.fireHandler) cmp.fireHandler(); else btn.click();
      mostrarAviso("Confirmação: Sim (soma)", false);
    } catch (e) { console.error("[IDS-qtd] erro confirmação:", e); }
  }, 100);

  // quantidade de uma bipada: caixa = TABELA; avulso = AVULSO (ou QTD_AVULSO); etiqueta 999 só preenche se o código estiver listado
  function unidadeDoCodigo(codigoLido, cbLote) {
    const avulso = ehEtiquetaAvulsa(codigoLido);
    const semZeros = codigoLido.replace(/^0+/, "");
    const etiquetaAntiga = codigoLido.startsWith("999");   // etiqueta do sistema antigo
    return avulso
      ? (etiquetaAntiga
          ? (buscar(AVULSO, [codigoLido, cbLote]) ?? buscar(TABELA, [codigoLido]))
          : (buscar(AVULSO, [cbLote, semZeros]) || QTD_AVULSO))
      : buscar(TABELA, [codigoLido, cbLote]);
  }

  // ===== Data da Receita (só existe na saída): preenche com a data de HOJE se estiver vazia =====
  // Nunca sobrescreve uma data já preenchida. Se a receita for de outro dia, é só trocar a data na tela.
  const PREENCHER_DATA_RECEITA = true;   // false desliga
  const RE_DATA_RECEITA = /^Data da Receita:$/;

  function dataHojeBR() {
    const d = new Date();
    return String(d.getDate()).padStart(2, "0") + "/" + String(d.getMonth() + 1).padStart(2, "0") + "/" + d.getFullYear();
  }

  function preencherDataReceita() {
    if (!PREENCHER_DATA_RECEITA) return;
    const campo = campoPorRotulo(RE_DATA_RECEITA);
    if (!campo || campo.value) return;              // não existe (transferência) ou já tem data: não mexe
    const cmp = window.Ext && Ext.getCmp(campo.dataset.componentid);
    if (cmp && cmp.setValue) {
      cmp.setValue(cmp.format ? new Date() : dataHojeBR());   // datefield do Ext aceita Date; senão texto dd/mm/aaaa
      if (cmp.checkChange) cmp.checkChange();
    } else {
      preencher(campo, dataHojeBR());
    }
    console.log("[IDS-qtd] Data da Receita preenchida:", campo.value || dataHojeBR());
  }

  // depois de uma soma direta, o Enter (keypress/keyup) também não deve chegar ao IDS
  let engolirEnter = false;
  ["keypress", "keyup"].forEach((tipo) => document.addEventListener(tipo, (e) => {
    if (e.key !== "Enter" || !engolirEnter) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (tipo === "keyup") engolirEnter = false;
  }, true));

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const cod = campoPorRotulo(RE_COD);
    if (!cod || e.target !== cod || !cod.value) return;

    fecharCalculadora();   // nova bipada: fecha a calculadora anterior

    const codigoLido = cod.value.trim();
    const avulso = ehEtiquetaAvulsa(codigoLido);   // começa com 0 ou 999 = etiqueta avulsa
    console.log("[IDS-qtd] código bipado:", codigoLido, "|", avulso ? "AVULSO" : "CAIXA");

    const loteAntes = campoPorRotulo(RE_LOTE);
    const antes = { lote: loteAntes ? loteAntes.value : "", qtd: lerQtd() };
    ultimaBipada = { codigo: codigoLido, t: Date.now(),
                     soma: antes.qtd > 0 && antes.lote !== "" && codigoLido === ultimaBipada.codigo };

    // Soma direta (só na SAÍDA): mesmo código do item que já está na tela e com quantidade preenchida.
    // O IDS não recebe esse Enter, então não recalcula a suficiência nem pergunta nada.
    if (SOMAR_REBIPADA_SEM_IDS && ultimaBipada.soma && !campoPorRotulo(RE_QTD_REQ)) {
      const mCb = antes.lote.match(/C\.B\.:\s*(\S+)/);
      const cbTela = mCb ? mCb[1] : null;
      const confere = cbTela && (cbTela === codigoLido || cbTela === codigoLido.replace(/^0+/, ""));
      const unid = confere ? unidadeDoCodigo(codigoLido, cbTela) : undefined;
      const qtdCampoDireto = campoPorRotulo(RE_QTD);
      if (unid !== undefined && qtdCampoDireto) {
        e.preventDefault();
        e.stopImmediatePropagation();
        engolirEnter = true;
        setTimeout(() => { engolirEnter = false; }, 500);   // garantia: nunca fica preso
        preencher(cod, "");                                 // limpa o código, como o IDS faria
        const alvoDireto = antes.qtd + unid;
        preencher(qtdCampoDireto, alvoDireto);
        console.log("[IDS-qtd] soma direta (sem passar pelo IDS):", antes.qtd, "+", unid, "=", alvoDireto);
        mostrarAviso((avulso ? "AVULSO" : "CAIXA") + ": +" + unid, avulso);
        setTimeout(() => {
          const q2 = campoPorRotulo(RE_QTD);
          if (q2 && lerQtd() !== alvoDireto) preencher(q2, alvoDireto);   // reaplica se foi sobrescrito
          focarCodigo();
        }, CONFERE_MS);
        return;
      }
    }
    let inicio = Date.now();
    let esperaDesde = 0;

    const t = setInterval(() => {
      try {
        // IDS perguntando (confirmação de prazo mínimo): não conta o tempo enquanto a janela estiver aberta,
        // para a soma acontecer depois da resposta (no máx. 60 s de espera)
        if (janelaConfirmacaoPrazo()) {
          if (!esperaDesde) esperaDesde = Date.now();
          if (Date.now() - esperaDesde < 60000) { inicio = Date.now(); return; }
        }
        const decorrido = Date.now() - inicio;
        const lote = campoPorRotulo(RE_LOTE);
        if (decorrido > LIMITE_MS) {
          clearInterval(t);
          console.warn("[IDS-qtd] tempo esgotado. Lote do Fabricante:", lote ? lote.value : "(campo não encontrado)",
                       "| campo do código ainda tem:", (campoPorRotulo(RE_COD) || {}).value);
          return;
        }

        const qtdCampo = campoPorRotulo(RE_QTD);
        if (!lote || !qtdCampo) return;
        const textoLote = lote.value || "";
        if (!textoLote) return;                       // o IDS ainda não trouxe o item

        const mudou = textoLote !== antes.lote;
        if (!mudou) {                                  // mesmo item bipado de novo
          if (decorrido < MIN_MESMO_ITEM_MS) return;
          const codAtual = campoPorRotulo(RE_COD);
          if (EXIGIR_CAMPO_LIMPO && codAtual && codAtual.value) return;  // IDS ainda não processou o código
        }
        clearInterval(t);
        preencherDataReceita();                              // saída: data de hoje se estiver vazia
        setTimeout(preencherDataReceita, CONFERE_MS);        // reaplica se o IDS limpou o campo

        const m = textoLote.match(/C\.B\.:\s*(\S+)/);
        const cbLote = m ? m[1] : null;                // C.B. do lote mostrado pelo IDS
        const unidade = unidadeDoCodigo(codigoLido, cbLote);   // regra de caixa/avulso na função acima
        console.log("[IDS-qtd] item pronto em", decorrido, "ms | bipado:", codigoLido, "| C.B. do lote:", cbLote,
                    "| quantidade da tabela:", unidade, "| antes:", antes);

        if (unidade === undefined) {
          console.log("[IDS-qtd] nem o código bipado nem o C.B. do lote estão na tabela: não preenche");
          if (CALC_PARA_DESCONHECIDOS) setTimeout(() => mostrarCalculadora(1, false), CONFERE_MS + 60);
          return;
        }

        let alvo = null;
        if (!mudou && antes.qtd > 0) alvo = antes.qtd + unidade;   // soma
        else if (!lerQtd()) alvo = unidade;                        // primeira bipada
        if (alvo === null) {
          console.log("[IDS-qtd] quantidade já preenchida (", lerQtd(), "): não mexe");
          return;
        }

        preencher(qtdCampo, alvo);
        console.log("[IDS-qtd] preenchido:", alvo);
        mostrarAviso((avulso ? "AVULSO" : "CAIXA") + ": +" + unidade, avulso);
        setTimeout(() => mostrarCalculadora(unidade, avulso), CONFERE_MS + 60);   // calculadora (só abre na transferência)
        setTimeout(() => voltarAoCodigo(qtdCampo), 60);
        setTimeout(() => {
          if (lerQtd() !== alvo) preencher(qtdCampo, alvo);        // reaplica se foi sobrescrito
          voltarAoCodigo(qtdCampo);
        }, CONFERE_MS);
      } catch (erro) {
        clearInterval(t);
        console.error("[IDS-qtd] erro:", erro);
      }
    }, INTERVALO_MS);
  }, true);

  // ===== Janela "Histórico de Saídas de Insumos" (bloqueio de retirada antecipada) =====
  const AUTO_FECHAR_HISTORICO = false;   // true = clica em "Sair" sozinho | false = só devolve o foco quando VOCÊ fechar
  const RE_JANELA_HIST = /Hist.rico de Sa.das de Insumos/i;

  function janelaHistorico() {
    return [...document.querySelectorAll(".x-window")].find(w =>
      w.offsetParent !== null &&
      RE_JANELA_HIST.test((w.querySelector(".x-window-header, .x-header, .x-title")?.textContent || "")));
  }

  function focarCodigo() {
    const cod = campoPorRotulo(RE_COD);
    if (cod) { cod.focus(); cod.select && cod.select(); }
  }

  let histAberta = false;
  let histClicada = false;

  setInterval(() => {
    try {
      const w = janelaHistorico();
      if (w) {
        histAberta = true;
        if (AUTO_FECHAR_HISTORICO && !histClicada) {
          const btn = [...w.querySelectorAll(".x-btn")].find(b => /^\s*Sair\s*$/i.test(b.textContent));
          if (btn) {
            histClicada = true;
            console.log("[IDS-qtd] janela de histórico detectada: clicando em Sair");
            const cmp = window.Ext && Ext.getCmp(btn.id);
            if (cmp && cmp.fireHandler) cmp.fireHandler(); else btn.click();
          }
        }
      } else if (histAberta) {                       // a janela acabou de fechar
        histAberta = false;
        histClicada = false;
        console.log("[IDS-qtd] histórico fechado: voltando ao campo do código");
        setTimeout(focarCodigo, 80);
        setTimeout(focarCodigo, 300);                // reforço caso o IDS mexa no foco depois
      }
    } catch (e) { console.error("[IDS-qtd] erro histórico:", e); }
  }, 150);
})();
