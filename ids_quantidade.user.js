// ==UserScript==
// @name         IDS - Quantidade automática ao bipar
// @namespace    ids-bariri-quantidade
// @version      1.7.5
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
  const TABELAS_RECARREGAR_MIN = 5;                 // releitura periódica com a página aberta (0 = só ao carregar)
  const TABELAS_CACHE_KEY = "ids-qtd-tabelas-v1";    // cópia local, usada se o GitHub estiver fora do ar

  const TABELA = {};   // etiqueta de caixa: C.B. -> quantidade por embalagem  (chave "caixa" do JSON)
  const AVULSO = {};   // etiqueta avulsa (envelope/cartela) quando NÃO for 1  (chave "avulso" do JSON)
  const CONTROLADOS = {};   // CÓDIGOS DE INSUMO controlados (o número antes do "-" no campo Insumo)  chave "controlados" do JSON
  let listaControladosDefinida = false;   // false = o JSON ainda não tem a chave "controlados"
  const PREVISAO_DIAS = {}; // CÓDIGOS DE INSUMO -> dias p/ próxima retirada (xaropes/gotas etc.)  chave "previsao_dias" do JSON
  let listaPrevisaoDefinida = false;      // false = o JSON ainda não tem a chave "previsao_dias"
  const NUMERO_RECEITA = {};// CÓDIGOS DE INSUMO -> número da receita padrão (ex.: "1")  chave "numero_receita" do JSON
  let listaNumeroReceitaDefinida = false; // false = o JSON ainda não tem a chave "numero_receita"
  let tabelasOrigem = "nenhuma";

  function aplicarTabelas(d) {
    for (const k of Object.keys(TABELA)) delete TABELA[k];
    for (const k of Object.keys(AVULSO)) delete AVULSO[k];
    for (const k of Object.keys(CONTROLADOS)) delete CONTROLADOS[k];
    for (const k of Object.keys(PREVISAO_DIAS)) delete PREVISAO_DIAS[k];
    for (const k of Object.keys(NUMERO_RECEITA)) delete NUMERO_RECEITA[k];
    Object.assign(TABELA, d.caixa);
    Object.assign(AVULSO, d.avulso);
    Object.assign(CONTROLADOS, d.controlados || {});
    Object.assign(PREVISAO_DIAS, d.previsao || {});
    Object.assign(NUMERO_RECEITA, d.numeroReceita || {});
    listaControladosDefinida = !!d.temLista;
    listaPrevisaoDefinida = !!d.temPrevisao;
    listaNumeroReceitaDefinida = !!d.temNumeroReceita;
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
    let ctrl = obj.controlados;                         // aceita {"861": 1} ou [861]
    if (Array.isArray(ctrl)) ctrl = Object.fromEntries(ctrl.map(c => [String(c).trim(), 1]));
    const temLista = typeof obj.temLista === "boolean" ? obj.temLista     // cópia local já traz a resposta
                                                       : (!!ctrl && typeof ctrl === "object");
    const controlados = limpar(ctrl, "controlados");
    // previsao_dias: aceita [110, 1174] (todos 15 dias) ou {"110": 15, "373": 30}
    // (do JSON vem como "previsao_dias"; da cópia local/cache vem já validado como "previsao")
    let pv = obj.previsao_dias !== undefined ? obj.previsao_dias : obj.previsao;
    if (Array.isArray(pv)) pv = Object.fromEntries(pv.map(c => [String(c).trim(), 15]));
    const temPrevisao = typeof obj.temPrevisao === "boolean" ? obj.temPrevisao
                                                             : (!!pv && typeof pv === "object");
    const previsao = limpar(pv, "previsao_dias");       // dias positivos (ex.: 15)
    // numero_receita: aceita [1234, 5678] (todos "1") ou {"1234": "1", "5678": "2"}
    // (do JSON vem como "numero_receita"; da cópia local/cache vem já validado como "numeroReceita")
    let nr = obj.numero_receita !== undefined ? obj.numero_receita : obj.numeroReceita;
    if (Array.isArray(nr)) nr = Object.fromEntries(nr.map(c => [String(c).trim(), "1"]));
    const temNumeroReceita = typeof obj.temNumeroReceita === "boolean" ? obj.temNumeroReceita
                                                                       : (!!nr && typeof nr === "object");
    const numeroReceita = {};
    if (nr && typeof nr === "object") {
      for (const [k, v] of Object.entries(nr)) {
        const val = String(v).trim();
        if (val) numeroReceita[String(k).trim()] = val;   // texto (o campo aceita qualquer coisa; padrão "1")
      }
    }
    return { caixa, avulso, controlados, temLista, previsao, temPrevisao, numeroReceita, temNumeroReceita };
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
                  "| avulsos especiais:", Object.keys(AVULSO).length,
                  "| controlados:", listaControladosDefinida ? Object.keys(CONTROLADOS).length : "sem lista (data para todos)",
                  "| previsão (xaropes/gotas):", listaPrevisaoDefinida ? Object.keys(PREVISAO_DIAS).length : "sem lista",
                  "| nº receita:", listaNumeroReceitaDefinida ? Object.keys(NUMERO_RECEITA).length : "sem lista");
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
  const LIMITE_MS = 8000;           // desiste depois disso (aumentado: PCs lentos demoravam mais que 3s p/ carregar o item)
  const CONFERE_MS = 400;           // reconfere se o IDS não sobrescreveu

  // ===== Rede de segurança: recupera sozinho quando o item carrega mas a quantidade não entra =====
  // (resolve o "bipa, puxa a info, mas não preenche; só F5 resolve" sem precisar de F5 nem F12)
  const AUTO_RECUPERAR = true;
  const RECUPERAR_APOS_MS = 2500;   // tempo com item carregado + quantidade vazia antes de preencher sozinho
  let ultimoCodigoBipado = { codigo: "", t: 0 };   // último código visto no campo ao dar Enter (p/ acertar caixa/avulso)
  let travadoDesde = 0;             // desde quando está "item carregado + quantidade vazia"
  let loteRecuperado = "";          // último lote já recuperado (não repete no mesmo item)
  const VOLTAR_AO_CODIGO_NA_SAIDA = false;  // true = também volta ao código na saída
  const EXIGIR_CAMPO_LIMPO = true;  // ao bipar o MESMO item de novo, só soma depois que o IDS limpar o campo do código

  // Etiqueta avulsa: começa com 0 (gerada pelo IDS, mesmo C.B. da caixa) ou 999 (sistema antigo)
  const QTD_AVULSO = 1;             // quantidade por bipada de etiqueta avulsa que não esteja na AVULSO
  const ehEtiquetaAvulsa = (codigo) => /^(0|999)\d+$/.test(codigo);

  console.log("[IDS-qtd] script carregado v1.7.5 |", (window === window.top ? "JANELA PRINCIPAL" : "IFRAME"), location.pathname,
              "| tabelas:", tabelasOrigem, "| caixa:", Object.keys(TABELA).length,
              "| avulsos especiais:", Object.keys(AVULSO).length);

  // aviso rápido no canto da tela com o que o script entendeu da última bipada (AVULSO/CAIXA/soma)
  const MOSTRAR_AVISO = false;   // false = não mostra o aviso no canto; o preenchimento continua igual
  const aviso = document.createElement("div");
  aviso.style.cssText = "position:fixed;top:6px;right:150px;z-index:2147483000;padding:4px 10px;" +
    "border-radius:6px;font:bold 13px Arial;color:#fff;pointer-events:none;display:none;" +
    "box-shadow:0 1px 4px rgba(0,0,0,.4)";
  document.body.appendChild(aviso);
  let tAviso = null;
  function mostrarAviso(texto, avulso) {
    if (!MOSTRAR_AVISO) { aviso.style.display = "none"; return; }
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

  // igual ao campoPorRotulo, mas procura SÓ dentro da janela do item (onde está a Quantidade).
  // Necessário quando o mesmo rótulo existe no formulário de fora e no do item (ex.: "Número da Receita:").
  function campoPorRotuloNoItem(regex) {
    const q = campoPorRotulo(RE_QTD);
    const janela = q ? q.closest(".x-window") : null;
    const raiz = janela || document;
    const rotulo = [...raiz.querySelectorAll("label")]
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

  // se o IDS recriar o <body> e soltar o aviso/calculadora da tela, coloca de volta
  setInterval(() => {
    try {
      if (document.body && !aviso.isConnected) document.body.appendChild(aviso);
      if (document.body && !calc.isConnected) document.body.appendChild(calc);
      manterDestaqueDataReceita();
    } catch (e) { /* ignora */ }
  }, 2000);

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
  // true = só preenche para insumos listados em "controlados" no tabelas.json (pelo código do insumo).
  // Enquanto o JSON não tiver a chave "controlados", continua preenchendo para todos.
  const SOMENTE_CONTROLADOS = true;
  // Destaca o campo Data da Receita quando o script preenche a data (para lembrar de conferir/trocar à mão).
  const DESTACAR_DATA_RECEITA = true;    // false desliga o destaque
  const COR_DESTAQUE_DATA = "#fff3b0";   // amarelo claro
  const RE_DATA_RECEITA = /^Data da Receita:$/;
  const RE_INSUMO = /^Insumo:$/;

  // ===== Número da Receita: preenche com "1" (padrão) só para os insumos listados em "numero_receita" =====
  // Para medicamentos cuja receita não traz número (ex.: TRAMADOL, PARACETAMOL+CODEÍNA) e o IDS exige o campo.
  // Nunca sobrescreve um número já digitado.
  const PREENCHER_NUMERO_RECEITA = true;      // false desliga
  const NUMERO_RECEITA_PADRAO = "1";          // valor quando a lista vem como [codigos]
  const RE_NUM_RECEITA = /^N.mero da Receita:$/i;

  // ===== Previsão de próxima retirada (xaropes, gotas etc.): preenche com HOJE + N dias =====
  // Só para os insumos listados em "previsao_dias" no tabelas.json (padrão 15 dias).
  const PREENCHER_PREVISAO = true;       // false desliga
  const FORCAR_PREVISAO = true;          // true = sempre põe hoje+N (sobrescreve) | false = só se estiver vazio
  const PREVISAO_DIAS_PADRAO = 15;
  const RE_PREVISAO = /^Previs.o:?$/i;   // campo "Previsão:" no formulário do item
  // MODO: como garantir os 15 dias.
  //  true  = preenche a DOSE DIÁRIA com (Quantidade / dias). O IDS então calcula sozinho a Suficiência (=dias)
  //          e a Previsão. Mostra a Suficiência, sem piscar. (depende do campo aceitar casas decimais)
  //  false = escreve a data direto na PREVISÃO (Suficiência fica vazia/0).
  // DESLIGADO: o modo Dose Diária (foca/desfoca o campo) estava TRAVANDO a janela do item
  // (botão Fechar parava de responder). Modo Previsão direta é estável.
  const USAR_DOSE_DIARIA = false;
  const RE_DOSE_DIARIA = /^Dose Di.ria:?$/i;
  let ultimaDose = { ins: null, qtd: null };   // controla pra não reaplicar a dose em loop
  // OBS: o IDS calcula a Suficiência sozinho pela Dose Diária e força 0 quando ela está vazia.
  // Se o script escrever 15 aqui, o IDS zera na hora -> fica "piscando". Por isso vem DESLIGADO.
  const PREENCHER_SUFICIENCIA = false;   // true tenta preencher a Suficiência (causa piscar; o IDS reseta pra 0)
  const RE_SUFICIENCIA = /^Sufici.ncia(\s*\(.*\))?:?$/i;   // "Suficiência:" ou "Suficiência (Dias):"

  // código do insumo na tela: "861 - CLORIDRATO DE FLUOXETINA 20MG" -> "861"
  function codigoInsumoDaTela() {
    const campo = campoPorRotulo(RE_INSUMO);
    const m = campo && (campo.value || "").match(/^\s*(\d+)\s*-/);
    return m ? m[1] : null;
  }

  function dataHojeBR() {
    const d = new Date();
    return String(d.getDate()).padStart(2, "0") + "/" + String(d.getMonth() + 1).padStart(2, "0") + "/" + d.getFullYear();
  }

  // data de hoje + N dias, no formato dd/mm/aaaa
  function dataMaisDiasBR(dias) {
    const d = new Date();
    d.setDate(d.getDate() + (Number(dias) || 0));
    return String(d.getDate()).padStart(2, "0") + "/" + String(d.getMonth() + 1).padStart(2, "0") + "/" + d.getFullYear();
  }

  // Garante os N dias de previsão, só para insumos listados em "previsao_dias" (xaropes/gotas).
  function preencherPrevisao() {
    if (!PREENCHER_PREVISAO || !listaPrevisaoDefinida) return;
    const ins = codigoInsumoDaTela();
    if (!ins || PREVISAO_DIAS[ins] === undefined) return;      // item não está na lista
    const dias = PREVISAO_DIAS[ins] || PREVISAO_DIAS_PADRAO;

    // MODO DOSE DIÁRIA: escreve Dose = Quantidade / dias e deixa o IDS calcular Suficiência e Previsão.
    if (USAR_DOSE_DIARIA) {
      const campoDose = campoPorRotulo(RE_DOSE_DIARIA);
      if (!campoDose) { console.warn("[IDS-qtd] Dose Diária: campo não encontrado na tela (confira o rótulo do campo)"); return; }
      const q = lerQtd();
      if (!q) return;                                          // sem quantidade ainda: espera a próxima passada
      const dose = q / dias;                                   // Suficiência = Qtd / Dose = dias
      const atualDose = parseFloat(String(campoDose.value || "").replace(",", ".")) || 0;
      // só aplica uma vez por (item + quantidade); se o campo já tem valor e nada mudou, não repete (evita loop)
      if (ultimaDose.ins === ins && ultimaDose.qtd === q && atualDose > 0) return;
      const cmpD = window.Ext && Ext.getCmp(campoDose.dataset.componentid);
      if (cmpD && cmpD.setValue) { cmpD.setValue(dose); if (cmpD.checkChange) cmpD.checkChange(); }
      else preencher(campoDose, dose);
      // o IDS só recalcula Suficiência/Previsão quando se SAI do campo: simula "clicar dentro e fora"
      try {
        campoDose.focus();
        campoDose.dispatchEvent(new Event("input", { bubbles: true }));
        campoDose.dispatchEvent(new Event("change", { bubbles: true }));
        if (cmpD && cmpD.fireEvent) { cmpD.fireEvent("change", cmpD, dose); cmpD.fireEvent("blur", cmpD); }
        campoDose.blur();
        campoDose.dispatchEvent(new Event("blur", { bubbles: true }));
        campoDose.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      } catch (e) { /* ignora */ }
      ultimaDose = { ins: ins, qtd: q };
      setTimeout(focarCodigo, 50);                             // devolve o foco ao campo do código
      console.log("[IDS-qtd] Dose Diária preenchida:", dose, "(p/", dias, "dias) | qtd", q, "| insumo", ins,
                  "-> o IDS deve calcular Suficiência =", dias);
      return;
    }

    // MODO PREVISÃO DIRETA: escreve a data em Previsão.
    const campo = campoPorRotulo(RE_PREVISAO);
    if (!campo) { console.warn("[IDS-qtd] Previsão: campo não encontrado na tela (confira o rótulo do campo)"); return; }
    const alvo = dataMaisDiasBR(dias);
    const atual = (campo.value || "").trim();
    if (!FORCAR_PREVISAO && atual) return;                     // já tem data e não é pra sobrescrever
    if (atual === alvo) return;                                // já está certo: não mexe
    const cmp = window.Ext && Ext.getCmp(campo.dataset.componentid);
    if (cmp && cmp.setValue) {
      const d = new Date(); d.setDate(d.getDate() + dias);
      cmp.setValue(cmp.format ? d : alvo);                     // datefield do Ext aceita Date; senão texto dd/mm/aaaa
      if (cmp.checkChange) cmp.checkChange();
    } else {
      preencher(campo, alvo);
    }
    console.log("[IDS-qtd] Previsão preenchida:", alvo, "(", dias, "dias) | insumo", ins);

    // Suficiência (Dias): preenche com o número de dias, pra aparecer a informação (o IDS deixa vazio sem Dose Diária)
    if (PREENCHER_SUFICIENCIA) {
      const campoSuf = campoPorRotulo(RE_SUFICIENCIA);
      if (!campoSuf) {
        console.warn("[IDS-qtd] Suficiência: campo não encontrado na tela (confira o rótulo do campo)");
      } else if (String(campoSuf.value || "").trim() !== String(dias)) {
        preencher(campoSuf, dias);
        console.log("[IDS-qtd] Suficiência preenchida:", dias, "dias | insumo", ins);
      }
    }
  }

  function preencherDataReceita() {
    if (!PREENCHER_DATA_RECEITA) return;
    const campo = campoPorRotulo(RE_DATA_RECEITA);
    if (!campo || campo.value) return;              // não existe (transferência) ou já tem data: não mexe
    if (SOMENTE_CONTROLADOS && listaControladosDefinida) {
      const ins = codigoInsumoDaTela();
      if (!ins || !CONTROLADOS[ins]) {
        console.log("[IDS-qtd] Data da Receita: insumo", ins, "não está em controlados: não preenche");
        return;
      }
    }
    const cmp = window.Ext && Ext.getCmp(campo.dataset.componentid);
    if (cmp && cmp.setValue) {
      cmp.setValue(cmp.format ? new Date() : dataHojeBR());   // datefield do Ext aceita Date; senão texto dd/mm/aaaa
      if (cmp.checkChange) cmp.checkChange();
    } else {
      preencher(campo, dataHojeBR());
    }
    destacarDataReceita(campo);
    console.log("[IDS-qtd] Data da Receita preenchida:", campo.value || dataHojeBR());
  }

  // Preenche o Número da Receita com "1" (padrão), só para os insumos listados em "numero_receita".
  function preencherNumeroReceita() {
    if (!PREENCHER_NUMERO_RECEITA || !listaNumeroReceitaDefinida) return;
    const ins = codigoInsumoDaTela();
    if (!ins || NUMERO_RECEITA[ins] === undefined) return;      // item não está na lista
    // procura DENTRO da janela do item: existe outro "Número da Receita" no formulário de fora
    const campo = campoPorRotuloNoItem(RE_NUM_RECEITA);
    if (!campo || (campo.value || "").trim()) return;           // não existe ou já tem número: não mexe
    const valor = NUMERO_RECEITA[ins] || NUMERO_RECEITA_PADRAO;
    const cmp = window.Ext && Ext.getCmp(campo.dataset.componentid);
    if (cmp && cmp.setValue) { cmp.setValue(valor); if (cmp.checkChange) cmp.checkChange(); }
    else preencher(campo, valor);
    console.log("[IDS-qtd] Número da Receita preenchido:", valor, "| insumo", ins);
  }

  // pinta o campo de amarelo para lembrar que a data foi posta pelo script (confira se a receita é de hoje)
  function destacarDataReceita(campo) {
    if (!DESTACAR_DATA_RECEITA || !campo) return;
    try {
      campo.style.setProperty("background-color", COR_DESTAQUE_DATA, "important");
      campo.style.setProperty("background-image", "none", "important");  // Ext usa imagem de fundo no input
      // marca para o loop reaplicar e para limpar quando o usuário editar à mão
      campo.dataset.idsDataDestacada = "1";
    } catch (e) {}
  }

  // reaplica o amarelo se o Ext repintar o campo, e tira o destaque assim que o usuário mexe na data
  function manterDestaqueDataReceita() {
    if (!DESTACAR_DATA_RECEITA) return;
    const campo = campoPorRotulo(RE_DATA_RECEITA);
    if (!campo || campo.dataset.idsDataDestacada !== "1") return;
    if (campo === document.activeElement) {
      // usuário clicou no campo para trocar a data: tira o destaque
      campo.style.removeProperty("background-color");
      campo.style.removeProperty("background-image");
      delete campo.dataset.idsDataDestacada;
      return;
    }
    if (campo.style.backgroundColor === "" ) {
      campo.style.setProperty("background-color", COR_DESTAQUE_DATA, "important");
      campo.style.setProperty("background-image", "none", "important");
    }
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
    // registra o código SEMPRE que houver Enter com o campo do código preenchido,
    // mesmo que o resto do handler não rode: a rede de segurança usa isso p/ acertar caixa/avulso
    if (cod && (cod.value || "").trim()) ultimoCodigoBipado = { codigo: cod.value.trim(), t: Date.now() };
    if (!cod || e.target !== cod || !cod.value) {
      // diagnóstico: Enter num campo com cara de código de barras, mas o script não achou o campo do código
      const alvo = e.target;
      if (alvo && alvo.tagName === "INPUT" && (alvo.value || "").length >= 8 && !calc.contains(alvo)) {
        console.warn("[IDS-qtd] Enter em campo com código, mas o script não reconheceu o campo do código | campo achado:",
                     !!cod, "| é o mesmo campo:", cod === alvo, "| valor:", alvo.value, "| id:", alvo.id);
      }
      return;
    }

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
        preencherPrevisao();                                   // xaropes/gotas: Previsão = hoje + N dias
        preencherNumeroReceita();                              // nº da receita "1" p/ os listados
        mostrarAviso((avulso ? "AVULSO" : "CAIXA") + ": +" + unid, avulso);
        setTimeout(() => {
          const q2 = campoPorRotulo(RE_QTD);
          if (q2 && lerQtd() !== alvoDireto) preencher(q2, alvoDireto);   // reaplica se foi sobrescrito
          preencherPrevisao();                                 // reaplica se o IDS recalculou a previsão
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
        preencherNumeroReceita();                            // nº da receita "1" p/ os listados (TRAMADOL etc.)
        setTimeout(preencherNumeroReceita, CONFERE_MS);

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
        preencherPrevisao();                                     // xaropes/gotas: Previsão = hoje + N dias
        mostrarAviso((avulso ? "AVULSO" : "CAIXA") + ": +" + unidade, avulso);
        setTimeout(() => mostrarCalculadora(unidade, avulso), CONFERE_MS + 60);   // calculadora (só abre na transferência)
        setTimeout(() => voltarAoCodigo(qtdCampo), 60);
        setTimeout(() => {
          if (lerQtd() !== alvo) preencher(qtdCampo, alvo);        // reaplica se foi sobrescrito
          preencherPrevisao();                                    // reaplica se o IDS recalculou a previsão
          voltarAoCodigo(qtdCampo);
        }, CONFERE_MS);
      } catch (erro) {
        clearInterval(t);
        console.error("[IDS-qtd] erro:", erro);
      }
    }, INTERVALO_MS);
  }, true);

  // ===== Janela "Histórico de Saídas de Insumos" =====
  // Essa janela abre em dois momentos, com o MESMO título:
  //   1) ao escolher o paciente (Usuário): vem com o campo Insumo VAZIO e lista tudo -> atrapalha.
  //   2) depois de colocar o medicamento: vem com o campo Insumo PREENCHIDO (ex.: "1140 - DIPIRONA 500 MG")
  //      e mostra só aquele item (previsão de retirada) -> ESSENCIAL, deixa aberta.
  const FECHAR_HISTORICO_GERAL = true;   // true = elimina a janela geral (Insumo vazio) | false = não mexe em nenhuma
  const AUTO_FECHAR_HISTORICO  = false;  // true = fecha QUALQUER histórico (inclusive a do item) | tem prioridade
  // true = esconde a janela no instante em que ela surge, então a geral nem chega a aparecer (fecha "por trás").
  // false = deixa a geral aparecer e só então fecha (fica visível por HIST_ESPERA_MS antes de sumir).
  // DESLIGADO: esconder máscaras de forma ampla estava interferindo em outras máscaras do IDS
  // (ex.: o "Aguarde" que travava até dar F5). Com false, o script NÃO mexe em máscara nenhuma
  // (o Ext fecha a janela e remove a máscara dela sozinho). A geral só dá uma piscadinha antes de sumir.
  const EVITAR_ABRIR_HISTORICO = false;
  // tempo (ms) de segurança com o Insumo vazio antes de concluir que é a geral e fechar.
  // Com EVITAR_ABRIR ligado a janela já está escondida nesse meio-tempo, então isso é invisível.
  // Serve de margem pra NUNCA fechar a do item (que preenche o Insumo em ~150ms).
  const HIST_ESPERA_MS = 600;
  // Ancorado no início: casa SÓ a janela de histórico de verdade ("Histórico de Saídas de Insumos"),
  // e NÃO a de impressão ("Imprimir Pesquisa - Histórico...") nem "Detalhe - Histórico...", que o script
  // fechava por engano ao clicar em Imprimir dentro do histórico.
  const RE_JANELA_HIST = /^\s*Hist.rico de Sa.das de Insumos/i;

  function ehJanelaHist(w) {
    return !!w && w.nodeType === 1 && w.matches && w.matches(".x-window") &&
      RE_JANELA_HIST.test((w.querySelector(".x-window-header, .x-header, .x-title")?.textContent || ""));
  }

  function janelaHistorico() {
    // acha a janela mesmo que esteja escondida com visibility:hidden (offsetParent continua != null)
    // IGNORA a janela aberta pelo botão (idsManual): essa é intocável, o IDS cuida dela.
    return [...document.querySelectorAll(".x-window")].find(w =>
      w.offsetParent !== null && ehJanelaHist(w) && w.dataset.idsManual !== "1");
  }

  // lê o valor do campo "Insumo:" DENTRO da janela de histórico (string vazia = janela geral / ainda carregando)
  function insumoDoHistorico(w) {
    const rotulo = [...w.querySelectorAll("label")]
      .find(l => /^Insumo:?$/i.test((l.textContent || "").trim().replace(/\s+/g, " ")));
    if (!rotulo) return "";
    const campo = document.getElementById(rotulo.getAttribute("for"));
    return campo ? (campo.value || "").trim() : "";
  }

  function fecharHistorico(w) {
    // 1) fecha pelo componente Ext da própria janela: funciona mesmo antes do botão "Sair" renderizar,
    //    e remove junto a máscara escura que o Ext coloca atrás da janela (sem deixar "tela preta").
    try {
      const cmpJanela = window.Ext && w.id && Ext.getCmp(w.id);
      if (cmpJanela) {
        if (typeof cmpJanela.close === "function") { cmpJanela.close(); return true; }
        if (typeof cmpJanela.destroy === "function") { cmpJanela.destroy(); return true; }
        if (typeof cmpJanela.hide === "function") { cmpJanela.hide(); return true; }
      }
    } catch (e) { /* cai no fallback abaixo */ }
    // 2) fallback: clica no botão "Sair" (só existe depois que a janela termina de carregar)
    const btn = [...w.querySelectorAll(".x-btn")].find(b => /^\s*Sair\s*$/i.test(b.textContent));
    if (!btn) return false;
    const cmp = window.Ext && Ext.getCmp(btn.id);
    if (cmp && cmp.fireHandler) cmp.fireHandler(); else btn.click();
    return true;
  }

  // Esconde a janela E a máscara escura do Ext (pra não ficar aquele fundo preto enquanto decide o que fazer).
  function esconderHistEmascara(w) {
    try {
      w.style.setProperty("visibility", "hidden", "important");
      // a máscara é um div do Ext (classe com "mask") visível cobrindo a tela; marca e esconde
      [...document.querySelectorAll(".x-mask, .ext-el-mask, [class*='mask']")].forEach((m) => {
        if (m === w || w.contains(m)) return;
        if (m.offsetParent === null) return;                 // já invisível
        if (m.offsetWidth < 200 || m.offsetHeight < 200) return; // máscara cobre área grande; ignora ícones
        if (!m.dataset.idsHistMask) {
          m.dataset.idsHistMask = "1";
          m.style.setProperty("visibility", "hidden", "important");
        }
      });
    } catch (e) { /* ignora */ }
  }

  // Mostra de volta a janela e a máscara que tinham sido escondidas (caso seja a janela do item).
  function revelarHistEmascara(w) {
    try {
      if (w) w.style.removeProperty("visibility");
      restaurarMascaras();
    } catch (e) { /* ignora */ }
  }

  function restaurarMascaras() {
    document.querySelectorAll('[data-ids-hist-mask="1"]').forEach((m) => {
      m.style.removeProperty("visibility");
      delete m.dataset.idsHistMask;
    });
  }

  function focarCodigo() {
    const cod = campoPorRotulo(RE_COD);
    if (cod) { cod.focus(); cod.select && cod.select(); }
  }

  let histAberta = false;
  let histClicada = false;        // já decidimos o que fazer com a janela atual
  let histVazioDesde = 0;         // horário em que a janela começou a aparecer com Insumo vazio
  let histPedidaManual = 0;       // horário do clique no botão "Histórico" (abre a consulta de propósito)

  // Se VOCÊ clicar no botão "Histórico" da barra, a próxima janela é mantida aberta (consulta proposital).
  const RE_BTN_HIST = /^\s*Hist.rico\s*$/i;
  const JANELA_MANUAL_MS = 6000;  // por quanto tempo (ms) depois do clique a janela conta como "pedida por você"
  document.addEventListener("click", (e) => {
    try {
      const btn = e.target.closest && e.target.closest(".x-btn, button, a");
      if (btn && RE_BTN_HIST.test((btn.textContent || "").trim().replace(/\s+/g, " "))) {
        histPedidaManual = Date.now();
        // LIMPEZA: fecha qualquer histórico automático que esteja escondido/pendente e restaura máscaras.
        // É isso que evita a máscara presa (= sistema travado) quando o automático e o manual se cruzam.
        [...document.querySelectorAll(".x-window")].forEach((w) => {
          if (ehJanelaHist(w) && w.dataset.idsManual !== "1") {
            w.style.removeProperty("visibility");
            fecharHistorico(w);
          }
        });
        restaurarMascaras();
        histClicada = false; histVazioDesde = 0; histAberta = false;
        console.log("[IDS-qtd] botão Histórico clicado: limpei o automático e vou manter a janela manual aberta");
      }
    } catch (e2) { /* ignora */ }
  }, true);

  // decide o destino da janela de histórico: geral -> fecha (escondida); item -> mostra e deixa aberta
  function tratarJanelaHist(w) {
    if (!w || histClicada) return;
    if (w.dataset.idsManual === "1") return;   // janela de consulta manual: intocável (o IDS cuida dela)
    histAberta = true;
    const insumo = insumoDoHistorico(w);
    const vazio = insumo === "";

    // Você abriu pelo botão "Histórico": marca como MANUAL e nunca mais mexe (o IDS cuida da máscara/Sair).
    if ((Date.now() - histPedidaManual) < JANELA_MANUAL_MS) {
      w.dataset.idsManual = "1";
      revelarHistEmascara(w);
      histClicada = false;    // não prende o estado global na janela manual (ela é independente)
      histVazioDesde = 0;
      histAberta = false;
      histPedidaManual = 0;   // consome: não vale para uma próxima janela
      console.log("[IDS-qtd] histórico aberto pelo botão: marcado como manual (intocável)");
      return;
    }

    if (AUTO_FECHAR_HISTORICO) {
      if (fecharHistorico(w)) { histClicada = true; restaurarMascaras(); console.log("[IDS-qtd] histórico: fechando (modo fechar tudo)"); }
      return;
    }
    if (!FECHAR_HISTORICO_GERAL) return;   // não mexe em nenhuma

    if (!vazio) {
      // é a janela do item (essencial): garante que fique visível (e a máscara também) e não mexe mais
      revelarHistEmascara(w);
      histClicada = true;
      console.log("[IDS-qtd] histórico do item (Insumo:", insumo, "): deixando aberto");
      return;
    }

    // Insumo vazio: pode ser a geral OU a do item ainda carregando -> esconde janela+máscara e espera confirmar
    if (EVITAR_ABRIR_HISTORICO) esconderHistEmascara(w);
    if (!histVazioDesde) histVazioDesde = Date.now();
    if (Date.now() - histVazioDesde >= HIST_ESPERA_MS) {
      if (fecharHistorico(w)) {
        histClicada = true;
        restaurarMascaras();   // o Ext já remove a máscara ao fechar; isso é só garantia
        console.log("[IDS-qtd] histórico GERAL (Insumo vazio): fechado" + (EVITAR_ABRIR_HISTORICO ? " sem aparecer" : ""));
      }
    }
  }

  // Observer: pega a janela no exato momento em que o IDS a insere, antes de pintar na tela.
  try {
    const obsHist = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          let w = ehJanelaHist(n) ? n : (n.querySelector ? [...n.querySelectorAll(".x-window")].find(ehJanelaHist) : null);
          if (!w) continue;
          if (w.dataset.idsManual === "1") continue;   // janela manual: não encosta
          // esconde JÁ (janela + máscara escura) se o Insumo ainda estiver vazio, pra geral não chegar a aparecer
          // (mas NÃO esconde se você acabou de clicar no botão Histórico: aí é consulta proposital)
          const pedidaManual = (Date.now() - histPedidaManual) < JANELA_MANUAL_MS;
          if (!pedidaManual && EVITAR_ABRIR_HISTORICO && FECHAR_HISTORICO_GERAL && !AUTO_FECHAR_HISTORICO && insumoDoHistorico(w) === "") {
            esconderHistEmascara(w);
          }
          tratarJanelaHist(w);
        }
      }
    });
    obsHist.observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) { console.error("[IDS-qtd] observer histórico falhou:", e); }

  // Loop de apoio: confirma a decisão ao longo do tempo e devolve o foco quando a janela fecha.
  setInterval(() => {
    try {
      const w = janelaHistorico();
      if (w) {
        histAberta = true;
        tratarJanelaHist(w);
      } else if (histAberta) {                       // a janela acabou de fechar
        histAberta = false;
        histClicada = false;
        histVazioDesde = 0;
        restaurarMascaras();                         // garante que nenhuma máscara fique escondida/presa
        console.log("[IDS-qtd] histórico fechado: voltando ao campo do código");
        setTimeout(focarCodigo, 80);
        setTimeout(focarCodigo, 300);                // reforço caso o IDS mexa no foco depois
      }
    } catch (e) { console.error("[IDS-qtd] erro histórico:", e); }
  }, 120);

  // ===== Rede de segurança: item carregado + quantidade vazia por um tempo -> preenche sozinho =====
  // Só age quando o fluxo normal NÃO preencheu (evita o F5). Usa o código realmente bipado,
  // então acerta caixa/avulso igual ao normal. Nunca mexe em item já com quantidade (não atrapalha a soma).
  setInterval(() => {
    if (!AUTO_RECUPERAR) return;
    try {
      if (campoPorRotulo(RE_QTD_REQ)) { travadoDesde = 0; return; }   // transferência: tem a calculadora, não mexe
      const qtdCampo = campoPorRotulo(RE_QTD);
      const lote = campoPorRotulo(RE_LOTE);
      const cod = campoPorRotulo(RE_COD);
      if (!qtdCampo || !lote) { travadoDesde = 0; return; }
      const textoLote = lote.value || "";
      const codVal = cod ? (cod.value || "").trim() : "";
      const qtd = lerQtd();

      if (!textoLote) loteRecuperado = "";   // formulário sem item: libera recuperar o próximo

      // "travado" = item carregado (Lote preenchido), quantidade vazia, campo do código já limpo,
      // e ainda não recuperamos esse mesmo lote
      const travado = textoLote && !qtd && !codVal && textoLote !== loteRecuperado;
      if (!travado) { travadoDesde = 0; return; }

      if (!travadoDesde) { travadoDesde = Date.now(); return; }
      if (Date.now() - travadoDesde < RECUPERAR_APOS_MS) return;

      // só recupera com o código realmente bipado há pouco (acerta caixa/avulso; sem isso, não arrisca)
      const recente = ultimoCodigoBipado.codigo && (Date.now() - ultimoCodigoBipado.t) < 20000;
      if (!recente) { travadoDesde = 0; return; }

      const m = textoLote.match(/C\.B\.:\s*(\S+)/);
      const cbLote = m ? m[1] : null;
      const unidade = unidadeDoCodigo(ultimoCodigoBipado.codigo, cbLote);
      if (unidade === undefined) { travadoDesde = 0; return; }   // não está na tabela: não preenche

      preencher(qtdCampo, unidade);
      loteRecuperado = textoLote;
      travadoDesde = 0;
      preencherPrevisao();   // xaropes/gotas: mantém a previsão também na recuperação
      preencherNumeroReceita();   // nº da receita "1" p/ os listados, também na recuperação
      console.log("[IDS-qtd] RECUPERAÇÃO automática: quantidade preenchida sem F5 | código:", ultimoCodigoBipado.codigo,
                  "| C.B. do lote:", cbLote, "| quantidade:", unidade);
      setTimeout(() => { if (lerQtd() !== unidade) preencher(qtdCampo, unidade); }, CONFERE_MS);
    } catch (e) { /* ignora */ }
  }, 500);

  // ===== Avisos "igrowl" (notificações verdes de sucesso) que empilham no canto e cobrem os ícones =====
  // Pega QUALQUER elemento com "igrowl" na classe e remove a caixa inteira (o invólucro mais externo).
  // NÃO toca em janelas .x-window de verdade.
  const SUPRIMIR_AVISOS = true;
  const AVISO_VIDA_MS = 1200;      // tempo na tela antes do script tirar (piscadinha p/ você ver o "sucesso")

  // dado um elemento com "igrowl" na classe, sobe até o invólucro mais externo que ainda tem "igrowl"
  function caixaIgrowl(el) {
    let top = el, p = el.parentElement;
    while (p && typeof p.className === "string" && /igrowl/i.test(p.className)) { top = p; p = p.parentElement; }
    return top;
  }

  setInterval(() => {
    if (!SUPRIMIR_AVISOS) return;
    try {
      const encontrados = [...document.querySelectorAll('[class*="igrowl"]')].filter(a => a.offsetParent !== null);
      if (!encontrados.length) return;
      const caixas = [...new Set(encontrados.map(caixaIgrowl))];   // dedup: uma entrada por notificação
      const agora = Date.now();
      caixas.forEach(a => { if (!a.dataset.idsVisto) a.dataset.idsVisto = String(agora); });
      const maisNovo = caixas[caixas.length - 1];
      caixas.forEach(a => {
        const idade = agora - Number(a.dataset.idsVisto);
        // tira os antigos quando empilham (mantém só o mais novo) e qualquer um após a vida curta
        if ((caixas.length > 1 && a !== maisNovo) || idade >= AVISO_VIDA_MS) {
          try { a.remove(); } catch (e) { /* ignora */ }
        }
      });
    } catch (e) { /* ignora */ }
  }, 250);
})();
