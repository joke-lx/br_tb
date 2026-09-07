/**
 * TabBoard - 标签页看板主入口（Shell）
 * 负责模块生命周期管理和视图切换
 */

import DataManager from '../shared/data-manager.js';
import EventBus from '../shared/event-bus.js';
import TimelineModule from '../timeline/index.js';
import GroupModule from '../group/index.js';
import LeetCodeModule from '../leetcode/index.js';
import BilibiliHistoryModule from '../bilibili-history/index.js';
import RecordingModule from '../recording/index.js';
import VideoProgressModule from '../video-progress/index.js';
import NoteModule from '../note/index.js';

class AppShell {
  constructor() {
    this.dataManager = new DataManager();
    this.eventBus = new EventBus();
    this.currentModule = null;
    this.currentView = 'timeline';
    this.storageChangeTimer = null;
    this.dropdownOpen = false;
    this.dropdownItems = [
      { viewName: 'leetcode',         label: 'LC',    desc: '150'  },
      { viewName: 'bilibili-history', label: 'Bili',  desc: '历史' },
      { viewName: 'note',            label: 'Note', desc: '便签' },
    ];
    // 模块实例缓存：保留有状态模块（bilibili-history 等）的实例，
    // 避免 view 切换时丢失 state / payload / items 等内存数据
    this.modules = {};
  }

  async init() {
    const data = await this.dataManager.loadData();
    const lastView = data.settings?.lastView || 'timeline';

    this._setupViewSwitchButtons();
    this._setupRefreshButton();
    this._setupImageErrorHandling();
    this._setupStorageChangeListener();

    await this.switchView(lastView, data);
  }

  _setupViewSwitchButtons() {
    document.getElementById('timelineViewBtn')?.addEventListener('click', () => this.switchView('timeline'));
    document.getElementById('groupViewBtn')?.addEventListener('click', () => this.switchView('group'));
    document.getElementById('recordingViewBtn')?.addEventListener('click', () => this.switchView('recording'));
    document.getElementById('videoProgressViewBtn')?.addEventListener('click', () => this.switchView('videoProgress'));

    const moreBtn = document.getElementById('moreViewBtn');
    moreBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      this._toggleDropdown();
    });
    this._setupDropdownDismiss();
  }

  _setupDropdownDismiss() {
    document.addEventListener('click', (e) => {
      if (!this.dropdownOpen) return;
      if (e.target.closest('#moreViewBtn, .nav-dropdown')) return;
      this._closeDropdown();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.dropdownOpen) this._closeDropdown();
    });
  }

  _toggleDropdown() {
    this.dropdownOpen ? this._closeDropdown() : this._openDropdown();
  }

  _openDropdown() {
    if (this.dropdownOpen) return;
    const moreBtn = document.getElementById('moreViewBtn');
    if (!moreBtn) return;

    const activeView = this.currentView;
    const html = `<div class="nav-dropdown" role="menu">${
      this.dropdownItems.map(it => `
        <button class="nav-dropdown-item ${activeView === it.viewName ? 'active' : ''}"
                data-view="${it.viewName}" role="menuitem">
          <span class="nav-dropdown-label">${it.label}</span>
          <span class="nav-dropdown-desc">${it.desc}</span>
        </button>`).join('')
    }</div>`;

    document.body.insertAdjacentHTML('beforeend', html);
    const dd = document.querySelector('.nav-dropdown');
    if (dd) {
      const rect = moreBtn.getBoundingClientRect();
      dd.style.top  = `${rect.bottom + 6}px`;
      dd.style.right = `${window.innerWidth - rect.right}px`;
    }

    document.querySelectorAll('.nav-dropdown-item').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const view = el.getAttribute('data-view');
        if (view) this.switchView(view);
      });
    });

    this.dropdownOpen = true;
    moreBtn.setAttribute('aria-expanded', 'true');
  }

  _closeDropdown() {
    if (!this.dropdownOpen) return;
    document.querySelectorAll('.nav-dropdown').forEach(el => el.remove());
    this.dropdownOpen = false;
    document.getElementById('moreViewBtn')?.setAttribute('aria-expanded', 'false');
  }

  _setupRefreshButton() {
    document.getElementById('refreshBtn')?.addEventListener('click', async () => {
      const data = await this.dataManager.loadData();
      if (this.currentModule) this.currentModule.render(data);
    });
  }

  _setupImageErrorHandling() {
    document.addEventListener('error', (e) => {
      if (e.target.tagName === 'IMG') e.target.style.display = 'none';
    }, true);
  }

  _setupStorageChangeListener() {
    chrome.storage.onChanged.addListener((changes, namespace) => {
      if (namespace !== 'local') return;

      // ⚠️ 去抖关键:仅 settings.activeNamespace 字段变化(ns 切换)
      // 时,view 自己已经调 render()(立即响应,不卡顿)。如果这里也 100ms 后再 render
      // 一次,看板会被「innerHTML='' → 重建 → 再 innerHTML='' → 再重建」两次,可见抖动。
      // 解决:跳过 ns-only 变化。其他 settings(主题、closeAfterCollect 等)仍走这条路径。
      if (changes.settings && !changes.groups && !changes.tabs
          && !changes.timelineSnapshots && !changes.recordings && !changes.recordingState) {
        const oldNs = changes.settings.oldValue?.activeNamespace;
        const newNs = changes.settings.newValue?.activeNamespace;
        if (oldNs !== newNs) return;
      }

      if (this.storageChangeTimer) clearTimeout(this.storageChangeTimer);
      this.storageChangeTimer = setTimeout(async () => {
        const data = await this.dataManager.loadData();
        if (this.currentModule) this.currentModule.render(data);
      }, 100);
    });
  }

  async switchView(viewName, initialData = null) {
    // recording 视图已内嵌到 tabboard shell,无需跳转,直接走 switch 分支即可

    // 缓存命中：复用已构造的模块实例，避免破坏有状态模块（bilibili-history）的内存数据。
    // 各模块的 destroy() 通常只做 container = null / 清理副作用，并不销毁内存中的 state/items/payload，
    // 因此把 cached 实例重新挂回原 <div> 容器并 render() 即可恢复视图。
    if (this.modules[viewName]) {
      this.currentModule = this.modules[viewName];
      this.currentView = viewName;
      this._updateViewUI(viewName);
      this._reattachModule(this.currentModule, viewName);
      const data = initialData || await this.dataManager.loadData();
      this.currentModule.render(data);
      this.currentModule.bindEvents();
      this._closeDropdown();
      await this.dataManager.sendMessage('updateSettings', {
        settings: { lastView: viewName }
      });
      return;
    }

    if (this.currentModule) {
      this.currentModule.destroy();
      this.currentModule = null;
    }

    this.currentView = viewName;
    this._updateViewUI(viewName);

    const data = initialData || await this.dataManager.loadData();

    let container;
    let ModuleClass;

    switch (viewName) {
      case 'group':
        container = document.getElementById('groupView');
        ModuleClass = GroupModule;
        break;
      case 'leetcode':
        container = document.getElementById('leetcodePanel');
        ModuleClass = LeetCodeModule;
        break;
      case 'bilibili-history':
        container = document.getElementById('bilibiliHistoryPanel');
        ModuleClass = BilibiliHistoryModule;
        break;
      case 'recording':
        container = document.getElementById('recordingView');
        ModuleClass = RecordingModule;
        break;
      case 'videoProgress':
        container = document.getElementById('videoProgressView');
        ModuleClass = VideoProgressModule;
        break;
      case 'note':
        container = document.getElementById('noteView');
        ModuleClass = NoteModule;
        break;
      case 'timeline':
      default:
        container = document.getElementById('timelineView');
        ModuleClass = TimelineModule;
        break;
    }

    this.currentModule = new ModuleClass(container, this.dataManager, this.eventBus);
    this.modules[viewName] = this.currentModule; // 进入缓存
    // Bug fix: 之前 init() 不被 await,导致 async init 内部的 data load 与 render(data) 竞态,
    // 表现为"通过 nav 切到 videoProgress → 白页,F5 后才能出现"。
    // 现在等 init 完成(其中包含 view.init 的异步加载),再 render & bindEvents。
    await this.currentModule.init();
    this.currentModule.render(data);
    this.currentModule.bindEvents();

    this._closeDropdown();
    await this.dataManager.sendMessage('updateSettings', {
      settings: { lastView: viewName }
    });
  }

  /**
   * 把缓存中的模块实例重新挂回到对应的 <div> 容器。
   * 不同模块的 setContainer 形态：
   *   - BilibiliHistoryModule.init() 调用 view.setContainer
   *   - LeetCodeModule.init()   调用 view.setContainer
   *   - TimelineModule.init()   仅初始化搜索输入（不依赖 container）
   *   - GroupModule.init()      no-op
   * 因此这里统一通过模块自身暴露的 _reattach(container) 钩子挂回；若不存在则直接调用 view.setContainer。
   */
  _reattachModule(module, viewName) {
    const containerMap = {
      'timeline': 'timelineView',
      'group': 'groupView',
      'leetcode': 'leetcodePanel',
      'bilibili-history': 'bilibiliHistoryPanel',
      'recording': 'recordingView',
      'videoProgress': 'videoProgressView',
      'note': 'noteView',
    };
    const el = document.getElementById(containerMap[viewName]);
    if (!el) return;
    module.container = el;
    if (typeof module.view?.setContainer === 'function') {
      module.view.setContainer(el);
    }
    if (typeof module._reattach === 'function') {
      module._reattach(el);
    }
  }

  _updateViewUI(viewName) {
    document.getElementById('timelineViewBtn')?.classList.toggle('active', viewName === 'timeline');
    document.getElementById('groupViewBtn')?.classList.toggle('active', viewName === 'group');
    document.getElementById('recordingViewBtn')?.classList.toggle('active', viewName === 'recording');
    document.getElementById('videoProgressViewBtn')?.classList.toggle('active', viewName === 'videoProgress');

    document.getElementById('timelineView').style.display = viewName === 'timeline' ? 'block' : 'none';
    document.getElementById('groupView').style.display = viewName === 'group' ? 'block' : 'none';
    document.getElementById('leetcodeView').style.display = viewName === 'leetcode' ? 'block' : 'none';
    document.getElementById('bilibiliHistoryView').style.display = viewName === 'bilibili-history' ? 'block' : 'none';
    document.getElementById('recordingView').style.display = viewName === 'recording' ? 'block' : 'none';
    document.getElementById('videoProgressView').style.display = viewName === 'videoProgress' ? 'block' : 'none';
    document.getElementById('noteView').style.display = viewName === 'note' ? 'block' : 'none';

    // More 按钮 active 状态：当前 view 属于 dropdown items 时高亮
    const inDropdown = this.dropdownItems.some(it => it.viewName === viewName);
    document.getElementById('moreViewBtn')?.classList.toggle('active', inDropdown);
  }

  /**
   * popup / background 通过 chrome.runtime.sendMessage / chrome.tabs.sendMessage
   * 触发当前 tabboard tab 切换视图。当前只支持 videoProgress;其他视图随时可加。
   */
  _setupExternalSwitchListener() {
    chrome.runtime.onMessage.addListener((request) => {
      if (request?.action === 'tabboardSwitchView') {
        if (request.view === 'videoProgress') {
          this.switchView('videoProgress');
          return false;
        }
      }
      return false;
    });
  }
}

const app = new AppShell();
document.addEventListener('DOMContentLoaded', () => app.init());

// 监听 popup / background 主动切视图(无 sendResponse,统一返回 false)
document.addEventListener('DOMContentLoaded', () => {
  app._setupExternalSwitchListener();

  // hash 路由 - 让老的独立 URL (#videoProgress 或 #videoProgress&archive=1 / &sort=GID)
  // 在自动 redirect 到 tabboard.html 后能落到正确视图与 mode
  const hash = window.location.hash.replace(/^#/, '');
  if (!hash) return;
  const [viewRaw, params] = hash.split('&').map(s => s.trim());
  const view = viewRaw;
  if (view === 'videoProgress') {
    // 等 AppShell.init 切完 lastView 之后补切
    setTimeout(() => {
      app.switchView('videoProgress');
      // archive=1 自动切 mode
      if (params && params.startsWith('archive=1')) {
        app.currentModule?.view?.toggleArchiveMode?.(true);
      }
      // sort=GID 自动开排序弹窗
      const sortMatch = params && params.match(/sort=([\w-]+)/);
      if (sortMatch) {
        const gid = sortMatch[1];
        setTimeout(() => {
          // lazy import SortDialog
          import('../video-progress/sort-dialog.js').then(m => {
            m.openSortDialog(gid, app.dataManager, async () => {
              await app.dataManager.loadData();
              app.currentModule?.render?.(app.dataManager.data);
            });
          });
        }, 200);
      }
    }, 100);
  }
});
