/**
 * Popup Groups Module
 * 分组管理功能（已合并专注搜索控制）
 *
 * 所有 group 数据读写走后台消息(→ background/group-model.js 领域层),
 * 本模块不做 read-modify-write。
 */

import { escapeHtml, showToast } from './utils.js';

const DEFAULT_COLORS = [
  '#ff6b6b', '#4ecdc4', '#45b7d1', '#f9ca24', '#6c5ce7',
  '#a29bfe', '#fd79a8', '#00b894', '#e17055', '#74b9ff'
];

let selectedColor = DEFAULT_COLORS[0];

/**
 * 发送消息 + 超时兜底(适配层尚未实现 namespace 相关 action 时不卡死)
 * @param {Object} message
 * @param {number} [timeoutMs=1500]
 * @returns {Promise<any|null>} 响应对象,或 null(超时/无响应)
 */
async function trySendMessage(message, timeoutMs = 1500) {
  try {
    return await Promise.race([
      chrome.runtime.sendMessage(message),
      new Promise((_, reject) => setTimeout(() => reject(new Error('NO_RESPONSE')), timeoutMs))
    ]);
  } catch (_) {
    return null;
  }
}

/**
 * 加载命名空间徽章 + 切换面板,渲染到 #namespaceSelector
 *
 * 识别优先:当前 ns 以高权重徽章展示(主元素);全部 ns 的 chips 与新建输入
 * 收进默认隐藏的切换面板(次级操作)。
 *
 * 数据源全部走 message(CLAUDE.md Group 数据访问规约:popup 不允许直接读 chrome.storage 拿 groups/tabs/settings.activeNamespace):
 *  - getActiveNamespace          → 当前 ns
 *  - getAllGroupsAcrossNamespaces → 跨 ns group 列表(从中聚合所有 ns 名)
 *
 * 适配层尚未实现这两个 action 时,优雅降级:渲染仅含 active ns 的徽章。
 *
 * @param {Object} options
 * @param {Function} [options.onChange] - (newNs) => void,setActiveNamespace 成功后调用
 */
export async function loadNamespaces({ onChange } = {}) {
  const container = document.getElementById('namespaceSelector');
  if (!container) return;

  let activeNs = null;
  const nsSet = new Set();

  // 1) 读当前 ns
  const activeResp = await trySendMessage({ action: 'getActiveNamespace' });
  if (activeResp?.activeNamespace) {
    activeNs = activeResp.activeNamespace;
    nsSet.add(activeNs);
  }

  // 2) 读跨 ns group 列表 → 聚合所有 ns 名
  const crossResp = await trySendMessage({ action: 'getAllGroupsAcrossNamespaces' });
  if (crossResp?.groups) {
    crossResp.groups.forEach(g => {
      if (g && typeof g.ns === 'string' && g.ns) nsSet.add(g.ns);
    });
  }

  // 3) 兜底:「default」是系统默认 ns,即使没有 group 在里面、即使迁移没跑,
  //    也必须出现在切换面板里 —— 否则用户切到新 ns 后无法切回 default。
  //    (老用户数据可能缺 ns 字段,或用户曾清空数据,面板里都会看不到 default)
  nsSet.add('default');

  // 兜底:适配层两个 action 都还没实现 → 用 'default' 作为唯一已知 ns
  if (activeNs === null) {
    activeNs = 'default';
  }

  const nsList = Array.from(nsSet).sort();

  // 防御:如果 active ns 已知但不在列表里(理论不会发生,真发生则回退到首个)
  if (!activeNs || !nsSet.has(activeNs)) {
    activeNs = nsList[0];
  }

  // 【识别优先 + 下拉式】≥2 个 ns 时,当前 ns 以高权重徽章展示(一眼看出「我在哪个 ns」),
  // 全部 ns 的 chips 收进「点击徽章展开」的下拉面板,「＋ 新建命名空间」是面板底部条目,
  // 点击后才展开输入行 —— 收起时只占一行,不与其他分组操作按钮抢空间,也无冗余重复。
  // 单 ns(只有 default)时连徽章都不渲染(没有可识别的上下文),只留「＋ 新建命名空间」入口。
  // 不再用 <input list> + <datalist> 做选择器:它和 Chrome 自身的表单历史 autofill
  // 下拉冲突,历史输入会覆盖 datalist 内容。
  const multiNs = nsList.length > 1;
  const topHtml = multiNs ? `
    <div class="namespace-switcher">
      <button id="nsBadge" class="ns-badge" title="当前命名空间「${escapeHtml(activeNs)}」,点击切换">
        <span class="ns-badge-dot"></span>
        <span id="nsBadgeName" class="ns-badge-name">${escapeHtml(activeNs)}</span>
        <span class="ns-badge-caret">▾</span>
      </button>
    </div>` : `
    <div class="namespace-switcher ns-single">
      <button id="namespaceNewSingle" class="namespace-new-single" title="新建命名空间">＋ 新建命名空间</button>
    </div>`;
  const chipsHtml = multiNs ? `
      <div class="namespace-chips" id="namespaceChips">
        ${nsList.map(ns => `
          <button class="ns-chip${ns === activeNs ? ' active' : ''}" data-ns="${escapeHtml(ns)}" title="切换到「${escapeHtml(ns)}」">
            ${escapeHtml(ns)}
          </button>
        `).join('')}
      </div>
      <button id="namespaceNewSingle" class="namespace-new-single" title="新建命名空间">＋ 新建命名空间</button>` : '';
  const createHtml = `
      <div class="namespace-create" id="namespaceCreate" hidden>
        <input id="namespaceInput" class="namespace-input" autocomplete="nope" autocorrect="off" autocapitalize="off" spellcheck="false"
          name="__tabboard_ns_input"
          placeholder="输入新 ns 名,按 Enter 创建" />
        <button id="namespaceApply" class="namespace-apply" title="创建该命名空间">应用</button>
      </div>`;

  container.innerHTML = `${topHtml}
    <div class="namespace-panel${multiNs ? '' : ' ns-panel-inline'}" id="namespacePanel" hidden>
      ${chipsHtml}
      ${createHtml}
    </div>
  `;

  const input = container.querySelector('#namespaceInput');
  const panel = container.querySelector('#namespacePanel');
  const createRow = container.querySelector('#namespaceCreate');
  if (!input || !panel) return;

  /** 同步徽章文案(切换成功后局部更新,避免整块重渲染) */
  function refreshBadge(ns) {
    const badgeName = container.querySelector('#nsBadgeName');
    if (badgeName) badgeName.textContent = ns;
    const badge = container.querySelector('#nsBadge');
    if (badge) badge.title = `当前命名空间「${ns}」,点击切换`;
  }

  /** 展开面板;create=true 时同时展开创建输入行并聚焦 */
  function openPanel(create = false) {
    panel.hidden = false;
    const badge = container.querySelector('#nsBadge');
    if (badge) badge.classList.add('open');
    if (create) {
      if (createRow) createRow.hidden = false;
      input.focus();
      input.select();
    }
  }

  /** 收起面板(含创建输入行) */
  function closePanel() {
    panel.hidden = true;
    if (createRow) createRow.hidden = true;
    const badge = container.querySelector('#nsBadge');
    if (badge) badge.classList.remove('open');
  }

  // 徽章(仅多 ns):点击展开/收起下拉面板
  const badge = container.querySelector('#nsBadge');
  if (badge) {
    badge.addEventListener('mousedown', (e) => {
      // mousedown 优先于 click/blur,避免 popup 因 input blur 关闭导致 click 丢失
      e.preventDefault();
      if (panel.hidden) openPanel(); else closePanel();
    });
  }

  // 「＋ 新建命名空间」(多 ns:面板底部条目 / 单 ns:顶部入口)— 展开面板 + 创建输入行;再点收起
  const newSingleBtn = container.querySelector('#namespaceNewSingle');
  if (newSingleBtn) {
    newSingleBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (!panel.hidden && createRow && !createRow.hidden) {
        closePanel();
      } else {
        openPanel(true);
      }
    });
  }

  /**
   * 提交 ns 切换。封装 async 逻辑,避免在多个事件处理器里重复样板。
   * - newNs:已经 trim 过的目标 ns;input 是「新建输入框」而非状态展示,
   *   失败时保留用户输入便于修正重试,成功则清空并收起面板。
   * - 创建出 ns 集合里不存在的新 ns(如单 ns → 双 ns)时,重建整个切换器
   *   以升级为完整模式(徽章 + 下拉)。
   */
  async function commitSwitch(newNs) {
    if (!newNs || newNs === activeNs) {
      input.value = '';
      closePanel();
      return;
    }
    const createdNew = !nsList.includes(newNs);
    const response = await trySendMessage({
      action: 'setActiveNamespace',
      namespace: newNs
    });
    if (!response || response.success === false || response.error) {
      showToast(document.querySelector('.app'), `切换失败: ${response?.error || '未知错误'}`, 'error');
      return;
    }
    activeNs = newNs;
    refreshBadge(newNs);
    input.value = '';
    closePanel();
    if (createdNew) {
      // ns 集合变化(如 1→2):重渲染切换器,升级为完整模式
      await loadNamespaces({ onChange });
    }
    if (typeof onChange === 'function') {
      await onChange(newNs);
    }
  }

  // ── 事件绑定(三重显式提交入口,防 popup 关闭丢保存) ──
  // 1) change 事件:用户按 Enter 或失焦时触发(popup 关闭前可能丢失,所以不能是唯一入口)
  input.addEventListener('change', (e) => {
    commitSwitch(e.target.value.trim());
  });

  // 2) Enter 键:即时提交,不依赖 change / blur(在 popup 关闭前能保证发出去);Escape 收起
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitSwitch(e.target.value.trim());
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closePanel();
    }
  });

  // ⚠️ 故意不挂 input 防抖自动提交:用户明确要求「显式确认才提交」(避免每按一键 250ms 后就被自动切 ns,
  //    即使还没按 Enter / 应用按钮)。保留 change / Enter / Apply / chip 四重显式入口已足够。

  // 3) 「应用」按钮:显式保存入口,鼠标点击走 mousedown 防 popup blur
  const applyBtn = container.querySelector('#namespaceApply');
  if (applyBtn) {
    applyBtn.addEventListener('mousedown', (e) => {
      // mousedown 在 input blur 之前触发,避免 popup 因 input blur 而关闭导致 click 丢失
      e.preventDefault();
      commitSwitch(input.value.trim());
    });
  }

  // 4) chip 列表:点哪个直接切哪个(active chip 高亮)
  container.querySelectorAll('.ns-chip').forEach(chip => {
    chip.addEventListener('mousedown', (e) => {
      // mousedown 优先于 click/blur,避免 popup 因 input blur 关闭
      e.preventDefault();
      commitSwitch(chip.dataset.ns);
    });
  });

  // 5) 面板外点击收起。用「捕获阶段(capture)」监听:popup 内其他组件
  //    (输入框/按钮/弹层)可能在 mousedown 冒泡阶段 stopPropagation,
  //    捕获阶段最先触发,保证「点外面关闭」一定生效。
  //    (每次重渲染移除旧监听再挂新监听,避免累积;container 内点击由各自的
  //    mousedown 处理,这里只关「点外面」的场景)
  if (document.__nsOutsideClose) {
    document.removeEventListener('mousedown', document.__nsOutsideClose, true);
  }
  const onOutside = (e) => {
    if (!container.contains(e.target)) closePanel();
  };
  document.__nsOutsideClose = onOutside;
  document.addEventListener('mousedown', onOutside, true);
}

/**
 * 加载全量分组列表 — 扁平化单行布局
 * 每行:色点 + 名称 + tab 数 + 三个状态 toggle(Goto ★ / 专注 🔍 / 默认 🎯)+ 删除
 * 状态 toggle 激活时 accent 高亮,再点取消;未激活时半透明,点击即激活。
 *
 * @param {Object} options
 * @param {Function} options.onDelete - 删除分组回调 (groupId)
 * @param {Function} options.onSetDefault - 设置默认分组回调 (groupId)
 * @param {Function} options.onToggleFocus - 切换专注搜索回调 (groupId, enabled, prevChecked)
 * @param {Function} [options.onToggleGoto] - 切换 goto 回调 (groupId, enabled)
 */
export async function loadGroups({ onDelete, onSetDefault, onToggleFocus, onToggleGoto } = {}) {
  const dataResponse = await chrome.runtime.sendMessage({ action: 'getAllData' });
  if (!dataResponse?.success) {
    document.getElementById('groupsList').innerHTML =
      '<div class="empty-state">加载分组失败</div>';
    return;
  }

  const groups = dataResponse.groups || [];
  const tabs = dataResponse.tabs || {};

  const groupsList = document.getElementById('groupsList');

  if (groups.length === 0) {
    // 拉一下当前 ns,把「其他 ns 有分组」的事实告诉用户,避免以为默认分组被删了
    const activeNsResp = await trySendMessage({ action: 'getActiveNamespace' });
    const activeNs = activeNsResp?.activeNamespace || activeNsResp?.namespace || '';
    groupsList.innerHTML = `
      <div class="empty-state">
        <div>当前命名空间「${escapeHtml(activeNs)}」暂无分组</div>
        ${activeNs && activeNs !== 'default'
          ? `<div style="margin-top:6px;font-size:12px;color:#888;">默认分组在「default」中,点击上方命名空间徽章可切换回来</div>`
          : `<div style="margin-top:6px;font-size:12px;color:#888;">点击「+ 添加分组」创建第一个</div>`}
      </div>`;
    return;
  }

  groupsList.innerHTML = groups.map(group => {
    const isGoto = group.goto === true;
    const isInFocus = group.inFocusSearch === true;
    const isDefault = group.isDefault === true;
    const tabCount = (tabs[group.id] || []).length;
    return `
      <div class="group-item${isDefault ? ' is-default' : ''}" data-id="${group.id}" style="--group-color: ${group.color}">
        <span class="group-color" title="${escapeHtml(group.color)}"></span>
        <span class="group-name" title="${escapeHtml(group.name)}">${escapeHtml(group.name)}</span>
        <span class="group-tab-count">${tabCount}</span>
        <div class="group-toggles">
          <button class="gt-toggle gt-goto${isGoto ? ' on' : ''}" data-id="${group.id}" data-action="toggle-goto"
            title="${isGoto ? '已在 goto 圆环展示,点击取消' : '设为 goto 圆环展示源'}">★</button>
          <button class="gt-toggle gt-focus${isInFocus ? ' on' : ''}" data-id="${group.id}" data-action="toggle-focus"
            title="${isInFocus ? '已加入专注搜索,点击移除' : '加入专注搜索'}">🔍</button>
          <button class="gt-toggle gt-default${isDefault ? ' on' : ''}" data-id="${group.id}" data-action="set-default" ${isDefault ? 'disabled' : ''}
            title="${isDefault ? '当前默认分组(快捷添加目标)' : '设为默认分组(快捷添加目标)'}">🎯</button>
          <button class="gt-toggle gt-delete" data-id="${group.id}" data-action="delete"
            title="删除分组">✕</button>
        </div>
      </div>`;
  }).join('');

  // ── 事件绑定(统一按 data-action 委托) ──
  groupsList.querySelectorAll('[data-action]').forEach(btn => {
    const groupId = btn.dataset.id;
    const action = btn.dataset.action;
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      switch (action) {
        case 'toggle-goto': {
          if (onToggleGoto) await onToggleGoto(groupId, !btn.classList.contains('on'));
          break;
        }
        case 'toggle-focus': {
          if (onToggleFocus) await onToggleFocus(groupId, !btn.classList.contains('on'), btn.classList.contains('on'));
          break;
        }
        case 'set-default': {
          if (onSetDefault) await onSetDefault(groupId);
          break;
        }
        case 'delete': {
          if (onDelete) await onDelete(groupId);
          break;
        }
      }
    });
  });
}

/**
 * 设置目标分组
 */
export async function setDefaultGroup(groupId) {
  await chrome.runtime.sendMessage({ action: 'setDefaultGroup', groupId });
}

/**
 * 删除分组（带确认）
 */
export async function deleteGroup(groupId) {
  const confirmed = await window.modal.confirm(
    '确定要删除这个分组吗?分组内的标签页也会被删除。',
    { title: '删除分组', type: 'danger', confirmText: '删除', cancelText: '取消' }
  );
  if (!confirmed) return false;
  await chrome.runtime.sendMessage({ action: 'deleteGroup', groupId });
  return true;
}

/**
 * 添加分组
 */
export async function addGroup(name, color) {
  if (!name?.trim()) {
    throw new Error('请输入分组名称');
  }
  await chrome.runtime.sendMessage({
    action: 'addGroup',
    name: name.trim(),
    color: color || selectedColor
  });
}

/**
 * 切换分组的专注搜索状态(走领域 API toggleGroupFocusSearch,不做本地 read-modify-write)
 */
export async function toggleFocusSearchGroup(groupId, enabled) {
  const response = await chrome.runtime.sendMessage({
    action: 'toggleGroupFocusSearch',
    groupId,
    value: enabled
  });
  if (!response?.success) {
    throw new Error(response?.error || 'toggleGroupFocusSearch failed');
  }
}

/**
 * 切换分组的 goto 状态(走 setGroupAsGoto 消息 → model toggleGoto)
 */
export async function toggleGotoGroup(groupId) {
  const response = await chrome.runtime.sendMessage({
    action: 'setGroupAsGoto',
    groupId
  });
  if (!response?.success) {
    throw new Error(response?.error || 'setGroupAsGoto failed');
  }
  return response.isGoto;
}

/**
 * 默认颜色相关（保留供 popup.js / colorPicker 使用）
 */
export function getDefaultColors() {
  return [...DEFAULT_COLORS];
}

export function getSelectedColor() {
  return selectedColor;
}

export function setSelectedColor(color) {
  selectedColor = color;
}
