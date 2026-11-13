const $ = (selector) => document.querySelector(selector);
const editor = $('#editor');
const body = $('#dialogBody');
const content = $('#content');
// The prototype supplies the account role at entry. Production should use the authenticated session.
const role = new URLSearchParams(location.search).get('role') === 'reviewer' ? 'reviewer' : 'issuer';
const permissions = {
  issuer: { issue: true, review: false },
  reviewer: { issue: false, review: true },
}[role];
const recordsChannel = new BroadcastChannel('angang-permit-records');
if (permissions.review) {
  $('aside a[aria-current="page"]').href = 'index.html?role=reviewer';
}
let page = 'records';
let filters = { keyword: '', org: '', status: '' };
const defaultOrg = { id: 'default-dsc', name: '东鞍山烧结厂', shortName: '东烧', prefix: 'DS' };
const exampleOrgs = [
  defaultOrg,
  { id: 'qds', name: '齐大山选矿厂', shortName: '齐选', prefix: 'QX' },
  { id: 'dgs', name: '大孤山球团厂', shortName: '大球', prefix: 'DQ' },
];
let state;
let database;
let working = false;
let noticeTimer;

function html(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('angang-related-party-permits', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('data');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function access(change) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('data', change ? 'readwrite' : 'readonly');
    const store = transaction.objectStore('data');
    const request = store.get('registry');
    let result;
    let failure;
    request.onsuccess = () => {
      result = request.result ?? { orgs: [], people: [], cards: [] };
      if (!change) return;
      try {
        change(result);
        store.put(result, 'registry');
      } catch (error) {
        failure = error;
        transaction.abort();
      }
    };
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(failure || transaction.error);
  });
}

const date = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
const certificateTitle = (org) => (org.shortName || org.name) + '长期相关方上岗证';
const cells = (values) => values.map((value) => '<td>' + html(value) + '</td>').join('');
const button = (label, action, index) => `<button data-action="${action}" data-index="${index}">${label}</button>`;

function table(columns, rows, empty) {
  return `<div class="table-wrap"><table><thead><tr>${columns.map((name) => '<th>' + name + '</th>').join('')}</tr></thead>
    <tbody>${rows.join('') || `<tr><td class="empty" colspan="${columns.length}">${empty}</td></tr>`}</tbody></table></div>`;
}

function cardStatus(card) {
  if (card.status === 'pending') return '待审核';
  if (card.status === 'rejected') return '审核驳回';
  return card.expiry < date() ? '已过期' : '有效';
}

function renderCardRows() {
  const keyword = filters.keyword.toLowerCase();
  const rows = state.cards.flatMap((card, index) => {
    const status = cardStatus(card);
    const matches = [card.number, card.person.name, card.person.identity, card.person.companies]
      .some((value) => String(value ?? '').toLowerCase().includes(keyword));
    if (!matches || (filters.org && card.org.id !== filters.org) || (filters.status && status !== filters.status)) return [];
    const review = permissions.review && card.status === 'pending';
    const actions = [
      button('预览上岗证', 'card', index),
      review ? button('审核', 'review', index) : '',
      permissions.issue && card.status === 'rejected' ? button('修改', 'edit', index) : '',
      card.number ? button('下载图片', 'download', index) : '',
    ].join('');
    return [`<tr>${cells([card.number || '审核通过后生成', card.person.name, card.person.trade, card.org.name, card.person.companies, card.expiry])}<td><span class="record-status" data-status="${status}">${status}</span></td><td class="record-actions">${actions}</td></tr>`];
  });
  if (permissions.review) {
    const pending = state.cards.filter((card) => card.status === 'pending').length;
    $('#reviewSummary').textContent = pending ? `待审核 ${pending} 条` : '暂无待审核申请';
  }
  $('#cardRows').innerHTML = table(
    ['上岗证编号', '姓名', '工种', '发证机构', '相关方单位名称', '有效期至', '状态', '操作'],
    rows, state.cards.length ? '没有符合条件的记录' : '暂无发证记录',
  );
}

function render() {
  if (page === 'mapping') {
    content.innerHTML = '<div class="toolbar"><h1>机构简称映射</h1></div>' +
      table(['机构全称', '证书简称', '编号字母码', '证书标题', '操作'], state.orgs.map((org, index) =>
        `<tr>${cells([org.name, org.shortName, org.prefix, certificateTitle(org)])}<td>${permissions.issue ? button('编辑映射', 'mapping', index) : '—'}</td></tr>`), '暂无机构');
    return;
  }
  const orgs = new Map([...state.orgs, ...state.cards.map((card) => card.org)].map((org) => [org.id, org.name]));
  const options = [...orgs].map(([id, name]) => `<option value="${html(id)}">${html(name)}</option>`).join('');
  content.innerHTML = `<div class="toolbar"><h1>发证记录</h1>${permissions.issue ? '<button class="primary" data-action="issue">＋ 发证</button>' : ''}</div>
    <form id="cardFilters" class="card-filters">
      <label>关键词<input name="keyword" placeholder="姓名、身份证号、证号或单位" value="${html(filters.keyword)}"></label>
      <label>发证机构<select name="org"><option value="">全部机构</option>${options}</select></label>
      <label>状态<select name="status"><option value="">全部状态</option><option>待审核</option><option>审核驳回</option><option>有效</option><option>已过期</option></select></label>
      <button class="primary">搜索</button><button type="button" data-action="reset">重置</button>
    </form>${permissions.review ? '<p id="reviewSummary" class="hint"></p>' : ''}<div id="cardRows"></div>`;
  const form = $('#cardFilters');
  form.elements.org.value = filters.org;
  form.elements.status.value = filters.status;
  form.onsubmit = (event) => {
    event.preventDefault();
    filters = Object.fromEntries(new FormData(form));
    filters.keyword = filters.keyword.trim();
    renderCardRows();
  };
  renderCardRows();
}

function editMapping(org) {
  open('编辑机构简称映射', `<form id="mappingForm"><div class="fields">
    <label class="full">机构全称<input value="${html(org.name)}" readonly></label>
    <label>证书简称<input name="shortName" required maxlength="24" value="${html(org.shortName)}"></label>
    <label>编号字母码<input name="prefix" required maxlength="12" pattern="[A-Za-z]+" value="${html(org.prefix)}"></label>
    </div><p id="formStatus" class="hint" role="status"></p>
    <div class="actions"><button class="primary">保存</button></div></form>`);
  $('#mappingForm').onsubmit = (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const shortName = form.get('shortName').trim();
    const prefix = form.get('prefix').toUpperCase();
    if (!shortName) return feedback('请输入证书简称。', true);
    save((registry) => {
      if (registry.orgs.some((item) => item.id !== org.id && item.prefix === prefix) ||
          registry.cards.some((card) => card.org.id !== org.id && card.org.prefix === prefix)) {
        throw new Error('该编号字母码已被其他机构使用。');
      }
      const current = { ...registry.orgs.find((item) => item.id === org.id), shortName, prefix };
      registry.orgs = registry.orgs.map((item) => item.id === org.id ? current : item);
      for (const card of registry.cards) {
        if (card.status === 'pending' && card.org.id === org.id) card.org = { ...current };
      }
    }, '机构映射已保存');
  };
}

for (const tab of document.querySelectorAll('[data-page]')) {
  tab.onclick = () => {
    if (!state) return;
    page = tab.dataset.page;
    for (const item of document.querySelectorAll('[data-page]')) item.setAttribute('aria-pressed', item === tab);
    render();
  };
}

function open(title, markup) {
  body.innerHTML = `<div class="dialog-heading"><h2 id="dialogTitle">${title}</h2><button type="button" class="dialog-close" data-close aria-label="关闭弹窗" title="关闭"><span aria-hidden="true">×</span></button></div>${markup}`;
  editor.setAttribute('aria-labelledby', 'dialogTitle');
  if (!editor.open) editor.showModal();
}

function feedback(message, error = false) {
  const status = $('#formStatus');
  status.textContent = message;
  status.classList.toggle('error', error);
}

async function save(change, message) {
  if (working) return;
  working = true;
  const controls = [...body.querySelectorAll('button, input, select')].filter((control) => !control.disabled);
  controls.forEach((control) => { control.disabled = true; });
  try {
    state = await access(change);
    recordsChannel.postMessage('changed');
    editor.close();
    render();
    const notice = $('#notice');
    notice.textContent = message;
    notice.hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { notice.hidden = true; }, 3000);
  } catch (error) {
    feedback(error.message || '保存失败，请重试。', true);
  } finally {
    working = false;
    controls.forEach((control) => { control.disabled = false; });
  }
}

function nextNumber(cards, org, year = date().slice(0, 4)) {
  const prefix = org.prefix + 'CQF' + year;
  const highest = cards.reduce((max, card) => card.number?.startsWith(prefix)
    ? Math.max(max, Number(card.number.slice(-5))) : max, 0);
  if (highest >= 99999) throw new Error('该机构本年度证号已用完。');
  return prefix + String(highest + 1).padStart(5, '0');
}

function seedDemoRecords(registry) {
  if (registry.demoRecordsAdded) return;

  const org = registry.orgs[0];
  const year = Number(date().slice(0, 4));
  const examples = [
    { name: '示例人员甲', trade: '电工', companies: '示例设备检修公司', status: 'pending' },
    { name: '示例人员乙', trade: '焊工', companies: '示例机械安装公司', status: 'rejected' },
    { name: '示例人员丙', trade: '清扫工', companies: '示例检修服务公司、示例环境服务公司', status: 'approved' },
    { name: '示例人员丁', trade: '设备维护工', companies: '示例设备维保公司', status: 'approved', expired: true },
  ];

  for (const [index, example] of examples.entries()) {
    const identity = 'DEMO-00' + (index + 1);
    const { name, trade, companies, status, expired } = example;
    const person = { orgId: org.id, identity, name, trade, companies };
    const card = {
      id: 'demo-permit-' + (index + 1),
      person,
      org,
      status,
      expiry: (expired ? year - 1 : year + 1) + '-12-31',
    };
    if (status === 'approved') {
      card.number = nextNumber(registry.cards, org, expired ? year - 1 : year);
      card.seal = org.name;
    }
    if (!registry.people.some((item) => item.identity === identity)) registry.people.push(person);
    registry.cards.push(card);
  }

  registry.demoRecordsAdded = true;
}

function cardView({ org, person, expiry, number, seal }) {
  return `<article class="card"><h3>${html(certificateTitle(org))}</h3><div class="card-grid">
    <div><dl><dt>上岗证编号</dt><dd>${html(number || '审核通过后生成')}</dd><dt>上岗证有效期至</dt><dd>${html(expiry)}</dd></dl></div>
    <div class="photo">证件照</div>
    <div><dl><dt>姓名</dt><dd>${html(person.name)}</dd><dt>身份证号</dt><dd>${html(person.identity)}</dd><dt>工种</dt><dd>${html(person.trade)}</dd></dl></div>
    </div>${seal ? `<div class="electronic-seal" aria-label="电子章"><span>${html(seal)}</span><strong>★</strong><small>电子章</small></div>` : ''}<p>相关方单位名称　${html(person.companies)}</p></article>`;
}

function downloadCard(card) {
  if (!card.number) return;
  const canvas = document.createElement('canvas');
  canvas.width = 1200;
  const ctx = canvas.getContext('2d');
  if (!ctx) return alert('无法生成图片，请重试。');

  const lines = [''];
  ctx.font = '24px sans-serif';
  for (const char of card.person.companies) {
    const last = lines.length - 1;
    if (ctx.measureText(lines[last] + char).width > 880) lines.push(char);
    else lines[last] += char;
  }
  canvas.height = Math.max(510, 400 + lines.length * 34);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#207ba5';
  ctx.lineWidth = 4;
  ctx.strokeRect(12, 12, canvas.width - 24, canvas.height - 24);
  ctx.beginPath();
  ctx.moveTo(12, 108);
  ctx.lineTo(1188, 108);
  ctx.moveTo(12, 358);
  ctx.lineTo(1188, 358);
  for (const x of [410, 600]) {
    ctx.moveTo(x, 108);
    ctx.lineTo(x, 358);
  }
  ctx.stroke();
  ctx.fillStyle = '#edf5fb';
  ctx.fillRect(412, 110, 186, 246);

  function write(value, x, y, size, width, color = '#252941', bold = false) {
    ctx.fillStyle = color;
    ctx.font = `${bold ? 'bold ' : ''}${size}px sans-serif`;
    ctx.fillText(value, x, y, width);
  }

  ctx.textAlign = 'center';
  write(certificateTitle(card.org), 600, 72, 42, 1100, '#252941', true);
  write('证件照', 505, 242, 24, 160, '#546780');
  ctx.textAlign = 'left';
  const fields = [
    ['上岗证编号', card.number, 36, 152, 350],
    ['上岗证有效期至', card.expiry, 36, 252, 350],
    ['姓名', card.person.name, 625, 144, 525],
    ['身份证号', card.person.identity, 625, 218, 525],
    ['工种', card.person.trade, 625, 292, 525],
  ];
  for (const [label, value, x, y, width] of fields) {
    write(label, x, y, 21, width, '#546780');
    write(value, x, y + 32, 27, width, '#252941', true);
  }
  write('相关方单位名称', 36, 397, 21, 175, '#546780');
  lines.forEach((line, index) => write(line, 36, 433 + index * 34, 24, 880));

  if (card.seal) {
    const x = 1070;
    const y = canvas.height - 100;
    ctx.strokeStyle = '#bd2424';
    for (const radius of [72, 66]) {
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.textAlign = 'center';
    write(card.seal, x, y - 23, 19, 108, '#bd2424', true);
    write('★', x, y + 14, 36, 52, '#bd2424');
    write('电子章', x, y + 44, 18, 90, '#bd2424');
  }

  canvas.toBlob((blob) => {
    if (!blob) return alert('无法生成图片，请重试。');
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = card.number + '.png';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, 'image/png');
}

function issueCard(rejectedCard) {
  const choices = state.orgs.map((org) => `<option value="${html(org.id)}" ${state.orgs[0].id === org.id ? 'selected' : ''}>${html(org.name)}</option>`).join('');
  open(rejectedCard ? '修改上岗证申请' : '发放上岗证', `<form id="personForm">
    <div class="fields">
      <label class="full">发证机构<select name="orgId" required><option value="">请选择机构</option>${choices}</select></label>
      <label class="full">身份证号<span class="lookup"><input name="identity" required maxlength="18" pattern="(?:[0-9]{17}[0-9Xx]|[Dd][Ee][Mm][Oo]\\x2d[0-9]{3})" placeholder="输入身份证号或 DEMO-001"><button type="button" id="lookup">检索</button></span></label>
      <label>姓名<input name="name" required maxlength="40"></label>
      <label>工种<input name="trade" required maxlength="40"></label>
      <label class="full">相关方单位名称<input name="companies" required maxlength="240" placeholder="多家单位用顿号隔开"></label>
      <label>上岗证有效期至<input name="expiry" type="date" required min="${date()}"></label>
    </div><p id="formStatus" class="hint" role="status"></p><div id="preview" hidden></div>
    <div class="actions"><button>预览证面</button><button class="primary" id="issue" type="button" disabled>提交审核</button></div></form>`);
  const form = $('#personForm');
  const fields = form.elements;
  let lookupVersion = 0;
  let preview;
  let knownIdentity = rejectedCard?.person.identity;
  if (rejectedCard) {
    const { person, org, expiry } = rejectedCard;
    fields.orgId.value = org.id;
    fields.identity.value = person.identity;
    fields.name.value = person.name;
    fields.trade.value = person.trade;
    fields.companies.value = person.companies;
    fields.expiry.value = expiry;
  }

  function invalidatePreview() {
    preview = undefined;
    $('#preview').hidden = true;
    $('#issue').disabled = true;
  }

  async function lookup() {
    const identity = fields.identity.value.trim().toUpperCase();
    if (!/^(?:[0-9]{17}[0-9X]|DEMO-[0-9]{3})$/.test(identity)) return feedback('请输入18位身份证号或示例编号。', true);
    const version = ++lookupVersion;
    feedback('正在检索人员…');
    try {
      const registry = await access();
      if (version !== lookupVersion || !form.isConnected || !editor.open) return;
      const match = registry.people.find((item) => item.identity === identity);
      knownIdentity = match?.identity;
      if (match) {
        fields.name.value = match.name;
        fields.trade.value = match.trade;
        fields.companies.value = match.companies;
        if (!fields.orgId.value) fields.orgId.value = match.orgId;
      }
      invalidatePreview();
      feedback(match ? '已带出姓名、工种和相关方单位，可按需修改。' : '未检索到人员，请手动填写。');
    } catch {
      if (version === lookupVersion && form.isConnected && editor.open) feedback('检索失败，请重试。', true);
    }
  }

  $('#lookup').onclick = lookup;
  fields.identity.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); lookup(); }
  });
  form.addEventListener('input', (event) => {
    ++lookupVersion;
    if (event.target === fields.identity && knownIdentity && fields.identity.value.trim().toUpperCase() !== knownIdentity) {
      fields.name.value = '';
      fields.trade.value = '';
      fields.companies.value = '';
      knownIdentity = undefined;
    }
    invalidatePreview();
    feedback('');
  });

  function upsert(registry, next) {
    const index = registry.people.findIndex((item) => item.identity === next.identity);
    if (index < 0) registry.people.push(next);
    else if (knownIdentity === next.identity) registry.people[index] = next;
    else throw new Error('该身份证号已有人员档案，请先检索。');
  }

  form.onsubmit = (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const next = {
      orgId: data.get('orgId'),
      identity: data.get('identity').trim().toUpperCase(),
      name: data.get('name').trim(),
      trade: data.get('trade').trim(),
      companies: [...new Set(data.get('companies').split(/[、，,]/).map((item) => item.trim()).filter(Boolean))].join('、'),
    };
    if (!next.name || !next.trade || !next.companies) return feedback('请填写姓名、工种和相关方单位名称。', true);
    const org = state.orgs.find((item) => item.id === next.orgId);
    try {
      preview = { org, person: next, expiry: data.get('expiry') };
      $('#preview').innerHTML = cardView(preview);
      $('#preview').hidden = false;
      $('#issue').disabled = false;
      feedback('审核通过后生成证号并加盖电子章。');
    } catch (error) {
      feedback(error.message, true);
    }
  };

  $('#issue').onclick = () => {
    if (!permissions.issue || !preview || !form.reportValidity()) return;
    const draft = preview;
    save((registry) => {
      const org = registry.orgs.find((item) => item.id === draft.org.id);
      if (org.name !== draft.org.name || org.shortName !== draft.org.shortName || org.prefix !== draft.org.prefix) throw new Error('机构信息已更新，请关闭后重新发证。');
      if (draft.expiry < date()) throw new Error('请选择今天或之后的有效期。');
      const index = rejectedCard ? registry.cards.findIndex((card) => card.id === rejectedCard.id) : -1;
      if (rejectedCard && registry.cards[index]?.status !== 'rejected') {
        throw new Error('该申请状态已变更，请刷新列表。');
      }
      upsert(registry, draft.person);
      const application = { ...draft, org, id: rejectedCard?.id ?? crypto.randomUUID(), status: 'pending' };
      if (rejectedCard) registry.cards[index] = application;
      else registry.cards.unshift(application);
    }, rejectedCard ? '修改已提交，等待重新审核' : '已提交审核');
  };
}

function openCard(card, review = false) {
  const pending = card.status === 'pending';
  const canReview = review && pending && permissions.review;
  const canPrint = Boolean(card.number);
  open(canReview ? '审核上岗证' : '预览上岗证', cardView(card) +
    `<p class="hint">状态　${cardStatus(card)}</p><p id="formStatus" class="hint" role="status"></p>` +
    (canReview ? '<div class="actions"><button type="button" data-review="rejected">驳回</button><button class="primary" type="button" data-review="approved">通过并盖章</button></div>' : '') +
    (canPrint ? '<div class="actions"><button data-print>打印证面</button><button class="primary" data-download>下载图片</button></div>' : ''));
  const download = body.querySelector('[data-download]');
  if (download) download.onclick = () => downloadCard(card);
  for (const decision of body.querySelectorAll('[data-review]')) {
    decision.onclick = () => {
      if (!permissions.review) return;
      const approved = decision.dataset.review === 'approved';
      save((registry) => {
        const current = registry.cards.find((item) => item.id === card.id);
        if (current?.status !== 'pending') throw new Error('该记录已审核，请刷新列表。');
        if (approved) {
          if (current.expiry < date()) throw new Error('证书有效期已过，请驳回后重新申请。');
          current.number = nextNumber(registry.cards, current.org);
          current.seal = current.org.name;
        }
        current.status = decision.dataset.review;
        current.reviewedAt = new Date().toISOString();
      }, approved ? '审核通过，已发证并盖章' : '已驳回');
    };
  }
}

body.addEventListener('click', (event) => {
  if (event.target.closest('[data-close]') && !working) editor.close();
  if (event.target.closest('[data-print]')) window.print();
});
editor.addEventListener('cancel', (event) => {
  if (working) event.preventDefault();
});
content.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const { action, index } = target.dataset;
  if (action === 'mapping' && permissions.issue) editMapping(state.orgs[index]);
  if (action === 'issue' && permissions.issue) issueCard();
  if (action === 'edit' && permissions.issue && state.cards[index]?.status === 'rejected') issueCard(state.cards[index]);
  if (action === 'card' || action === 'review') openCard(state.cards[index], action === 'review');
  if (action === 'download') downloadCard(state.cards[index]);
  if (action === 'reset') {
    filters = { keyword: '', org: '', status: '' };
    render();
  }
});

try {
  database = await openDatabase();
  state = await access((registry) => {
    if (!registry.orgMappingInitialized) {
      for (const org of exampleOrgs) {
        const index = registry.orgs.findIndex((item) => item.id === org.id);
        if (index >= 0) registry.orgs[index] = { ...registry.orgs[index], ...org };
        else registry.orgs.push({ ...org });
      }
      for (const card of registry.cards) {
        const current = registry.orgs.find((item) => item.id === card.org.id);
        if (card.status === 'pending' && current) card.org = { ...current };
      }
      registry.orgMappingInitialized = true;
    }
    seedDemoRecords(registry);

    const demoId = 'demo-permit-review-extra';
    if (!registry.cards.some((card) => card.status === 'pending' || card.id === demoId)) {
      const org = registry.orgs[0];
      const person = {
        orgId: org.id,
        identity: 'DEMO-005',
        name: '示例人员戊',
        trade: '设备巡检员',
        companies: '示例设备运维公司',
      };
      registry.cards.unshift({
        id: demoId,
        org,
        person,
        status: 'pending',
        expiry: (Number(date().slice(0, 4)) + 1) + '-12-31',
      });
      if (!registry.people.some((item) => item.identity === person.identity)) registry.people.push(person);
    }
  });
  render();
} catch {
  content.textContent = '无法读取本地数据库，请检查浏览器存储权限后刷新。';
}

recordsChannel.addEventListener('message', async () => {
  if (!state || working) return;
  try {
    state = await access();
    if (page === 'records') renderCardRows();
    else render();
  } catch {
    // The current list remains usable if a background refresh fails.
  }
});
