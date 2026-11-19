/* ANFAC MEDIA Shop - browser script for the anfac-media-store plugin.
 * Loaded after the main SAFAR KAABE page script. Uses the page globals when present
 * (apiRequest, escapeHtml, showToast, formatMoney, openAuthGate, currentUser) and falls back safely when not.
 */
(function () {
  'use strict';
  if (window.__anfacStorePluginLoaded) return;
  window.__anfacStorePluginLoaded = true;

  var CART_KEY = 'anfacStoreCart.v1';
  var CATEGORY_LABELS = { DESIGN: 'Design', VIDEO: 'Video', PHOTO: 'Photo', PRINTING: 'Printing', BRANDING: 'Branding', WEB: 'Website', OTHER: 'Other' };
  var STEPS = [
    ['NEW', 'Order sent'],
    ['CONFIRMED', 'Confirmed'],
    ['IN_PROGRESS', 'Being made'],
    ['READY', 'Ready'],
    ['DELIVERED', 'Delivered']
  ];
  var ACTION_LABELS = { CONFIRM: 'Confirm order', START: 'Start work', READY: 'Mark ready', DELIVER: 'Mark delivered', CANCEL: 'Cancel order' };
  var MAX_UPLOAD_BYTES = 1024 * 1024;

  var state = {
    info: null,
    products: [],
    manageProducts: [],
    orders: [],
    manageOrders: [],
    sellers: [],
    cart: loadCart(),
    tab: 'products',
    search: '',
    category: '',
    orderFilter: '',
    editingId: null,
    pendingImage: null,
    removeImage: false,
    focusOrderId: null,
    message: null,
    busy: false
  };

  // ---------- page helpers with safe fallbacks ----------

  function user() {
    try { return typeof currentUser !== 'undefined' ? currentUser : null; } catch (error) { return null; }
  }

  function esc(value) {
    if (typeof window.escapeHtml === 'function') return window.escapeHtml(value);
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function money(cents) {
    try { if (typeof window.formatMoney === 'function') return window.formatMoney(Number(cents) || 0); } catch (error) { /* fall through */ }
    return '$' + ((Number(cents) || 0) / 100).toFixed(2);
  }

  function toast(text) {
    try { if (typeof window.showToast === 'function') window.showToast(text); } catch (error) { /* ignore */ }
  }

  function readCsrf() {
    var entry = document.cookie.split('; ').find(function (cookie) { return cookie.indexOf('sk_csrf=') === 0; });
    return entry ? decodeURIComponent(entry.slice(8)) : '';
  }

  function api(path, options) {
    options = options || {};
    if (typeof window.apiRequest === 'function') return window.apiRequest(path, options);
    var headers = {};
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.method && options.method !== 'GET') headers['X-CSRF-Token'] = readCsrf();
    return fetch(path, {
      method: options.method || 'GET', headers: headers, credentials: 'same-origin', cache: 'no-store',
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (payload) {
        if (!response.ok) {
          var error = new Error(payload.error || 'Request failed (' + response.status + ').');
          error.status = response.status;
          throw error;
        }
        return payload;
      });
    });
  }

  function storeName() {
    return (state.info && state.info.store && state.info.store.name) || 'ANFAC MEDIA';
  }

  function loadCart() {
    try {
      var saved = JSON.parse(localStorage.getItem(CART_KEY) || '{}');
      var cart = {};
      Object.keys(saved || {}).forEach(function (id) {
        var qty = Number(saved[id]);
        if (/^[A-Za-z0-9-]{1,80}$/.test(id) && Number.isInteger(qty) && qty > 0) cart[id] = Math.min(qty, 100);
      });
      return cart;
    } catch (error) {
      return {};
    }
  }

  function saveCart() {
    try { localStorage.setItem(CART_KEY, JSON.stringify(state.cart)); } catch (error) { /* storage may be blocked */ }
    updateCartBadges();
  }

  function cartCount() {
    return Object.keys(state.cart).reduce(function (sum, id) { return sum + state.cart[id]; }, 0);
  }

  // ---------- navigation entries ----------

  var NAV_ICON = '<i class="fa-solid fa-bag-shopping w-4 text-center" aria-hidden="true"></i>';

  function injectNav() {
    var done = true;
    if (!document.getElementById('sidebar_STORE')) {
      var anchor = document.getElementById('sidebarSavedOffersButton') || document.getElementById('sidebar_MESSAGES');
      if (anchor && anchor.parentNode) {
        var button = document.createElement('button');
        button.type = 'button';
        button.id = 'sidebar_STORE';
        button.className = 'w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-semibold text-slate-400 hover:text-white hover:bg-white/5 transition';
        button.innerHTML = NAV_ICON + ' <span data-store-name-label>' + esc(storeName()) + ' Shop</span>' +
          '<span data-store-cart-badge class="hidden ml-auto rounded-full bg-[#C909E6] px-1.5 py-0.5 text-[9px] font-bold text-white"></span>';
        button.addEventListener('click', function () { openStore(); });
        anchor.parentNode.insertBefore(button, anchor.nextSibling);
      } else {
        done = false;
      }
    }
    if (!document.getElementById('mobileStoreButton')) {
      var mobileAnchor = document.getElementById('mobileSavedOffersButton');
      var grid = mobileAnchor ? mobileAnchor.parentNode : document.querySelector('#mobileMenuPanel .grid');
      if (grid) {
        var mobile = document.createElement('button');
        mobile.type = 'button';
        mobile.id = 'mobileStoreButton';
        mobile.className = 'relative rounded-xl border border-white/10 bg-white/5 p-3 text-left text-xs font-bold text-slate-200';
        mobile.innerHTML = '<i class="fa-solid fa-bag-shopping mr-2 text-fuchsia-300" aria-hidden="true"></i><span data-store-name-label>' +
          esc(storeName()) + ' Shop</span> <span data-store-cart-badge class="hidden rounded-full bg-[#C909E6] px-1.5 text-[9px] font-bold text-white"></span>';
        mobile.addEventListener('click', function () {
          try { if (typeof window.closeMobileMenu === 'function') window.closeMobileMenu(); } catch (error) { /* ignore */ }
          openStore();
        });
        if (mobileAnchor) grid.insertBefore(mobile, mobileAnchor.nextSibling);
        else grid.appendChild(mobile);
      } else {
        done = false;
      }
    }
    updateCartBadges();
    return done;
  }

  function updateNavLabels() {
    document.querySelectorAll('[data-store-name-label]').forEach(function (node) { node.textContent = storeName() + ' Shop'; });
  }

  function updateCartBadges() {
    var count = cartCount();
    document.querySelectorAll('[data-store-cart-badge]').forEach(function (node) {
      node.textContent = count > 99 ? '99+' : String(count);
      node.classList.toggle('hidden', count === 0);
    });
  }

  // ---------- modal ----------

  function ensureModal() {
    var modal = document.getElementById('storePluginModal');
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'storePluginModal';
    modal.className = 'fixed inset-0 z-[78] hidden items-stretch justify-center bg-black/70 backdrop-blur-sm sm:items-center sm:p-4 no-print';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'storePluginTitle');
    modal.innerHTML =
      '<div class="glass-panel flex h-full w-full max-w-5xl flex-col overflow-hidden border border-white/10 shadow-2xl sm:h-[90vh] sm:rounded-2xl">' +
        '<div class="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3">' +
          '<div class="flex min-w-0 items-center gap-3">' +
            '<span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#C909E6] text-white"><i class="fa-solid fa-bag-shopping" aria-hidden="true"></i></span>' +
            '<div class="min-w-0"><h2 id="storePluginTitle" class="truncate text-sm font-extrabold text-white"></h2>' +
            '<p class="truncate text-[11px] text-slate-400">Design, video, photo, printing and more</p></div>' +
          '</div>' +
          '<button type="button" data-store-action="close" class="rounded-lg p-2 text-slate-400 hover:bg-white/10 hover:text-white" aria-label="Close shop"><i class="fa-solid fa-xmark text-lg" aria-hidden="true"></i></button>' +
        '</div>' +
        '<div id="storePluginTabs" class="flex gap-1.5 overflow-x-auto border-b border-white/10 px-3 py-2" role="tablist"></div>' +
        '<div id="storePluginMessage" class="hidden mx-4 mt-3 rounded-xl border px-3 py-2 text-xs font-semibold" role="status" aria-live="polite"></div>' +
        '<div id="storePluginBody" class="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-4"></div>' +
      '</div>';
    document.body.appendChild(modal);
    if (!document.getElementById('storePluginStyles')) {
      // Success messages use the brand magenta; keep them readable in the light theme.
      var style = document.createElement('style');
      style.id = 'storePluginStyles';
      style.textContent = 'html[data-theme="light"] #storePluginModal .store-ok-text { color: #86059a; }';
      document.head.appendChild(style);
    }
    modal.addEventListener('click', onModalClick);
    modal.addEventListener('change', onModalChange);
    modal.addEventListener('input', onModalInput);
    modal.addEventListener('submit', onModalSubmit);
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !modal.classList.contains('hidden')) closeStore();
    });
    return modal;
  }

  function closeStore() {
    var modal = document.getElementById('storePluginModal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    document.body.classList.remove('overflow-hidden');
  }

  function showMessage(text, kind) {
    state.message = text ? { text: text, kind: kind || 'info' } : null;
    var box = document.getElementById('storePluginMessage');
    if (!box) return;
    if (!state.message) {
      box.classList.add('hidden');
      return;
    }
    box.className = 'mx-4 mt-3 rounded-xl border px-3 py-2 text-xs font-semibold ' + (kind === 'error'
      ? 'border-rose-500/40 bg-rose-500/10 text-rose-300'
      : 'border-[#C909E6]/40 bg-[#C909E6]/10 text-[#E27BF5] store-ok-text');
    box.textContent = text;
    if (kind !== 'error') {
      setTimeout(function () { if (state.message && state.message.text === text) showMessage(null); }, 4000);
    }
  }

  async function openStore(tab) {
    var modal = ensureModal();
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    document.body.classList.add('overflow-hidden');
    if (tab) state.tab = tab;
    showMessage(null);
    renderShell();
    document.getElementById('storePluginBody').innerHTML = '<p class="py-10 text-center text-xs text-slate-400"><i class="fa-solid fa-spinner fa-spin mr-2" aria-hidden="true"></i>Loading the shop...</p>';
    try {
      await loadInfo();
      if (!tabs().some(function (entry) { return entry[0] === state.tab; })) state.tab = 'products';
      await loadTabData();
    } catch (error) {
      showMessage(error.message || 'The shop could not load. Try again.', 'error');
    }
    render();
  }

  async function loadInfo() {
    state.info = await api('/api/store/info');
    updateNavLabels();
  }

  async function loadTabData() {
    var signedIn = Boolean(user());
    if (state.tab === 'products' || state.tab === 'cart') {
      state.products = (await api('/api/store/products')).products || [];
    } else if (state.tab === 'orders' && signedIn) {
      state.orders = (await api('/api/store/orders')).orders || [];
    } else if (state.tab === 'manage' && isSeller()) {
      state.manageProducts = (await api('/api/store/products?manage=1')).products || [];
    } else if (state.tab === 'sellerOrders' && isSeller()) {
      state.manageOrders = (await api('/api/store/orders?manage=1')).orders || [];
    } else if (state.tab === 'sellers' && canManageSellers()) {
      state.sellers = (await api('/api/store/sellers')).sellers || [];
    }
  }

  function isSeller() { return Boolean(state.info && state.info.isSeller && user()); }
  function canManageSellers() { return Boolean(state.info && state.info.canManageSellers && user()); }

  function tabs() {
    var list = [
      ['products', 'Products', 'fa-store'],
      ['cart', 'Cart', 'fa-cart-shopping'],
      ['orders', 'My orders', 'fa-receipt']
    ];
    if (isSeller()) {
      list.push(['manage', 'Manage products', 'fa-pen-to-square']);
      list.push(['sellerOrders', 'Orders', 'fa-inbox']);
    }
    if (canManageSellers()) list.push(['sellers', 'Sellers', 'fa-user-tie']);
    return list;
  }

  function renderShell() {
    var title = document.getElementById('storePluginTitle');
    if (title) title.textContent = storeName() + ' Shop';
    var bar = document.getElementById('storePluginTabs');
    if (!bar) return;
    var count = cartCount();
    bar.innerHTML = tabs().map(function (entry) {
      var active = entry[0] === state.tab;
      var badge = entry[0] === 'cart' && count ? ' <span class="ml-1 rounded-full bg-[#C909E6] px-1.5 text-[10px] text-white">' + count + '</span>' : '';
      return '<button type="button" role="tab" aria-selected="' + active + '" data-store-action="tab" data-tab="' + entry[0] + '" class="shrink-0 whitespace-nowrap rounded-xl px-3 py-2 text-xs font-bold ' +
        (active ? 'bg-[#C909E6] text-white' : 'border border-white/10 bg-white/5 text-slate-300 hover:text-white') + '">' +
        '<i class="fa-solid ' + entry[2] + ' mr-1.5" aria-hidden="true"></i>' + esc(entry[1]) + badge + '</button>';
    }).join('');
  }

  function render() {
    renderShell();
    var body = document.getElementById('storePluginBody');
    if (!body) return;
    var html = '';
    if (state.tab === 'products') html = renderProducts();
    else if (state.tab === 'cart') html = renderCart();
    else if (state.tab === 'orders') html = renderOrders();
    else if (state.tab === 'manage') html = renderManage();
    else if (state.tab === 'sellerOrders') html = renderSellerOrders();
    else if (state.tab === 'sellers') html = renderSellers();
    body.innerHTML = html;
    if (state.focusOrderId) {
      var target = document.getElementById('store-order-' + state.focusOrderId);
      if (target) {
        target.classList.add('ring-2', 'ring-[#C909E6]');
        target.scrollIntoView({ block: 'center' });
      }
      state.focusOrderId = null;
    }
  }

  function signInPrompt(text) {
    return '<div class="glass-panel rounded-2xl border border-white/10 p-6 text-center">' +
      '<i class="fa-solid fa-right-to-bracket text-2xl text-fuchsia-300" aria-hidden="true"></i>' +
      '<p class="mt-3 text-sm font-bold text-white">' + esc(text) + '</p>' +
      '<button type="button" data-store-action="signin" class="mt-4 rounded-xl bg-[#C909E6] px-4 py-2.5 text-xs font-bold text-white">Sign in</button></div>';
  }

  function emptyBox(icon, text) {
    return '<div class="rounded-2xl border border-dashed border-white/10 bg-white/5 p-8 text-center text-xs text-slate-400">' +
      '<i class="fa-solid ' + icon + ' mb-2 block text-2xl text-slate-500" aria-hidden="true"></i>' + esc(text) + '</div>';
  }

  function stockText(stock) {
    if (stock === null || stock === undefined) return 'Available';
    if (Number(stock) === 0) return 'Sold out';
    return stock + ' left';
  }

  function productImage(product, classes) {
    if (product.imageUrl) {
      return '<img src="' + esc(product.imageUrl) + '" alt="' + esc(product.title) + '" loading="lazy" class="' + classes + ' object-cover">';
    }
    return '<div class="' + classes + ' flex items-center justify-center bg-white/5 text-slate-500"><i class="fa-solid fa-image text-2xl" aria-hidden="true"></i></div>';
  }

  // ---------- Products ----------

  // The search box and category list are rendered once per tab render; typing only re-renders #storeProductList,
  // so the input element is never replaced mid-composition (phone keyboards, autocorrect, IME).
  function renderProducts() {
    var categories = (state.info && state.info.categories) || Object.keys(CATEGORY_LABELS);
    return '<div class="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_12rem]">' +
      '<label class="sr-only" for="storeSearch">Search products</label>' +
      '<input id="storeSearch" data-store-input="search" type="search" value="' + esc(state.search) + '" placeholder="Search products" class="obsidian-input w-full rounded-xl px-3 py-2.5 text-xs text-white">' +
      '<label class="sr-only" for="storeCategory">Category</label>' +
      '<select id="storeCategory" data-store-input="category" class="obsidian-input w-full rounded-xl px-3 py-2.5 text-xs text-white">' +
        '<option value="">All categories</option>' +
        categories.map(function (category) {
          return '<option value="' + esc(category) + '"' + (category === state.category ? ' selected' : '') + '>' + esc(CATEGORY_LABELS[category] || category) + '</option>';
        }).join('') +
      '</select></div>' +
      '<div id="storeProductList">' + renderProductList() + '</div>';
  }

  function refreshProductList() {
    var container = document.getElementById('storeProductList');
    if (container) container.innerHTML = renderProductList();
    else render();
  }

  function renderProductList() {
    var search = state.search.trim().toLowerCase();
    var list = state.products.filter(function (product) {
      if (state.category && product.category !== state.category) return false;
      if (!search) return true;
      return (product.title + ' ' + product.description + ' ' + (CATEGORY_LABELS[product.category] || '')).toLowerCase().indexOf(search) !== -1;
    });
    if (!state.products.length) return emptyBox('fa-store', 'No products yet. Check back soon.');
    if (!list.length) return emptyBox('fa-magnifying-glass', 'No products match your search.');
    var html = '<div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">';
    list.forEach(function (product) {
      var soldOut = product.stock !== null && Number(product.stock) === 0;
      var inCart = state.cart[product.id] || 0;
      html += '<article class="glass-panel flex flex-col overflow-hidden rounded-2xl border border-white/10">' +
        productImage(product, 'h-44 w-full') +
        '<div class="flex flex-1 flex-col gap-2 p-3">' +
          '<div class="flex items-start justify-between gap-2">' +
            '<h3 class="min-w-0 break-words text-sm font-extrabold text-white">' + esc(product.title) + '</h3>' +
            '<span class="shrink-0 rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] font-bold text-slate-300">' + esc(CATEGORY_LABELS[product.category] || product.category) + '</span>' +
          '</div>' +
          (product.description ? '<p class="whitespace-pre-line break-words text-xs text-slate-400">' + esc(product.description) + '</p>' : '') +
          '<div class="mt-auto flex items-end justify-between gap-2 pt-2">' +
            '<div><div class="text-sm font-extrabold text-white">' + esc(money(product.priceCents)) + '</div>' +
            '<div class="text-[11px] ' + (soldOut ? 'text-rose-300' : 'text-slate-400') + '">' + esc(stockText(product.stock)) + (inCart ? ' · ' + inCart + ' in cart' : '') + '</div></div>' +
            '<button type="button" data-store-action="add" data-id="' + esc(product.id) + '"' + (soldOut ? ' disabled' : '') +
              ' class="rounded-xl px-3 py-2 text-xs font-bold ' + (soldOut ? 'cursor-not-allowed border border-white/10 bg-white/5 text-slate-500' : 'bg-[#C909E6] text-white') + '">' +
              '<i class="fa-solid fa-cart-plus mr-1.5" aria-hidden="true"></i>' + (soldOut ? 'Sold out' : 'Add to cart') + '</button>' +
          '</div>' +
        '</div></article>';
    });
    return html + '</div>';
  }

  function addToCart(id) {
    var product = state.products.find(function (entry) { return entry.id === id; });
    if (!product) return;
    var next = (state.cart[id] || 0) + 1;
    if (product.stock !== null && next > Number(product.stock)) {
      showMessage('Only ' + product.stock + ' left of "' + product.title + '".', 'error');
      return;
    }
    state.cart[id] = Math.min(next, 100);
    saveCart();
    showMessage('"' + product.title + '" added to your cart.');
    render();
  }

  // ---------- Cart ----------

  function renderCart() {
    var ids = Object.keys(state.cart);
    if (!ids.length) {
      return emptyBox('fa-cart-shopping', 'Your cart is empty.') +
        '<div class="mt-4 text-center"><button type="button" data-store-action="tab" data-tab="products" class="rounded-xl bg-[#C909E6] px-4 py-2.5 text-xs font-bold text-white">See products</button></div>';
    }
    var total = 0;
    var unavailable = 0;
    var rows = ids.map(function (id) {
      var qty = state.cart[id];
      var product = state.products.find(function (entry) { return entry.id === id; });
      if (!product) {
        unavailable += 1;
        return '<div class="flex items-center justify-between gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-300">' +
          '<span>A product in your cart is no longer for sale.</span>' +
          '<button type="button" data-store-action="remove" data-id="' + esc(id) + '" class="rounded-lg px-2 py-1 font-bold underline">Remove</button></div>';
      }
      total += product.priceCents * qty;
      return '<div class="flex items-center gap-3 rounded-xl border border-white/10 bg-white/5 p-3">' +
        productImage(product, 'h-14 w-14 shrink-0 rounded-lg') +
        '<div class="min-w-0 flex-1"><div class="truncate text-xs font-bold text-white">' + esc(product.title) + '</div>' +
        '<div class="text-[11px] text-slate-400">' + esc(money(product.priceCents)) + ' each</div></div>' +
        '<div class="flex shrink-0 items-center gap-1">' +
          '<button type="button" data-store-action="qty" data-id="' + esc(id) + '" data-delta="-1" class="h-8 w-8 rounded-lg border border-white/10 bg-white/5 text-white" aria-label="One less"><i class="fa-solid fa-minus text-[10px]" aria-hidden="true"></i></button>' +
          '<span class="w-7 text-center text-xs font-bold text-white">' + qty + '</span>' +
          '<button type="button" data-store-action="qty" data-id="' + esc(id) + '" data-delta="1" class="h-8 w-8 rounded-lg border border-white/10 bg-white/5 text-white" aria-label="One more"><i class="fa-solid fa-plus text-[10px]" aria-hidden="true"></i></button>' +
          '<button type="button" data-store-action="remove" data-id="' + esc(id) + '" class="ml-1 h-8 w-8 rounded-lg text-rose-300 hover:bg-rose-500/10" aria-label="Remove"><i class="fa-solid fa-trash text-[11px]" aria-hidden="true"></i></button>' +
        '</div></div>';
    }).join('');
    var current = user();
    var payment = (state.info && state.info.store && state.info.store.paymentInstructions) || '';
    var form = current
      ? '<form data-store-form="order" class="space-y-3">' +
          '<label class="block text-[11px] font-semibold text-slate-400">Your phone number' +
            '<input name="phone" type="tel" required maxlength="40" value="' + esc(current.phone || '') + '" placeholder="+252 61 000 0000" class="obsidian-input mt-1 w-full rounded-xl px-3 py-2.5 text-xs text-white"></label>' +
          '<label class="block text-[11px] font-semibold text-slate-400">Note for the seller (optional)' +
            '<textarea name="note" rows="3" maxlength="1000" placeholder="Sizes, colors, dates or anything the seller should know" class="obsidian-input mt-1 w-full rounded-xl px-3 py-2.5 text-xs text-white"></textarea></label>' +
          '<div class="rounded-xl border border-[#C909E6]/30 bg-[#C909E6]/10 p-3 text-xs text-slate-200"><i class="fa-solid fa-circle-info mr-1.5 text-fuchsia-300" aria-hidden="true"></i>' + esc(payment) + '</div>' +
          '<button type="submit"' + (unavailable ? ' disabled' : '') + ' class="w-full rounded-xl bg-[#C909E6] px-4 py-3 text-sm font-extrabold text-white disabled:opacity-50">Place order</button>' +
        '</form>'
      : signInPrompt('Sign in to place your order.');
    return '<div class="grid gap-4 lg:grid-cols-[1fr_20rem]">' +
      '<div class="space-y-2">' + rows + '</div>' +
      '<div class="space-y-3">' +
        '<div class="glass-panel rounded-2xl border border-white/10 p-4">' +
          '<div class="flex items-center justify-between text-sm font-extrabold text-white"><span>Total</span><span>' + esc(money(total)) + '</span></div>' +
          '<p class="mt-1 text-[11px] text-slate-400">The final price is checked when you place the order.</p>' +
        '</div>' + form +
      '</div></div>';
  }

  function changeQty(id, delta) {
    var product = state.products.find(function (entry) { return entry.id === id; });
    var next = (state.cart[id] || 0) + delta;
    if (product && product.stock !== null && next > Number(product.stock)) {
      showMessage('Only ' + product.stock + ' left of "' + product.title + '".', 'error');
      return;
    }
    if (next <= 0) delete state.cart[id];
    else state.cart[id] = Math.min(next, 100);
    saveCart();
    render();
  }

  async function placeOrder(form) {
    var items = Object.keys(state.cart).map(function (id) { return { productId: id, quantity: state.cart[id] }; });
    if (!items.length) return;
    try {
      var result = await api('/api/store/orders', {
        method: 'POST',
        body: { items: items, phone: form.phone.value, note: form.note.value }
      });
      state.cart = {};
      saveCart();
      state.tab = 'orders';
      state.focusOrderId = result.order && result.order.id;
      await loadTabData();
      showMessage('Order ' + result.order.reference + ' sent. The seller will contact you.');
      toast('Order ' + result.order.reference + ' sent.');
    } catch (error) {
      showMessage(error.message || 'The order could not be placed.', 'error');
      if (error.status === 409) state.products = (await api('/api/store/products').catch(function () { return { products: state.products }; })).products || [];
    }
    render();
  }

  // ---------- Orders ----------

  function timeline(order) {
    if (order.status === 'CANCELLED') {
      return '<div class="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-300"><i class="fa-solid fa-ban mr-1.5" aria-hidden="true"></i>This order was cancelled.' +
        (order.cancelReason ? ' Reason: ' + esc(order.cancelReason) : '') + '</div>';
    }
    var currentIndex = STEPS.findIndex(function (step) { return step[0] === order.status; });
    return '<ol class="grid grid-cols-5 gap-1" aria-label="Order progress">' + STEPS.map(function (step, index) {
      var done = index <= currentIndex;
      return '<li class="flex flex-col items-center gap-1 text-center">' +
        '<span class="flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-bold ' + (done ? 'bg-[#C909E6] text-white' : 'border border-white/10 bg-white/5 text-slate-500') + '">' +
        (done ? '<i class="fa-solid fa-check" aria-hidden="true"></i>' : index + 1) + '</span>' +
        '<span class="text-[10px] leading-tight ' + (index === currentIndex ? 'font-bold text-white' : 'text-slate-400') + '">' + esc(step[1]) + '</span></li>';
    }).join('') + '</ol>';
  }

  function orderCard(order, sellerView) {
    var date = '';
    try { date = new Date(order.createdAt).toLocaleString(); } catch (error) { date = order.createdAt; }
    var items = order.items.map(function (item) {
      return '<li class="flex justify-between gap-2"><span class="min-w-0 break-words">' + item.quantity + ' × ' + esc(item.title) + '</span><span class="shrink-0">' + esc(money(item.lineCents)) + '</span></li>';
    }).join('');
    var actions = (order.allowedActions || []).filter(function (action) { return sellerView || action === 'CANCEL'; });
    var buttons = actions.map(function (action) {
      var danger = action === 'CANCEL';
      return '<button type="button" data-store-action="orderAction" data-id="' + esc(order.id) + '" data-order-action="' + action + '" data-seller="' + (sellerView ? '1' : '0') + '" class="rounded-xl px-3 py-2 text-xs font-bold ' +
        (danger ? 'border border-rose-500/40 bg-rose-500/10 text-rose-300' : 'bg-[#C909E6] text-white') + '">' + esc(ACTION_LABELS[action] || action) + '</button>';
    }).join('');
    return '<article id="store-order-' + esc(order.id) + '" class="glass-panel space-y-3 rounded-2xl border border-white/10 p-4">' +
      '<div class="flex flex-wrap items-start justify-between gap-2">' +
        '<div><div class="font-mono-code text-sm font-extrabold text-white">' + esc(order.reference) + '</div>' +
        '<div class="text-[11px] text-slate-400">' + esc(date) + '</div></div>' +
        '<span class="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] font-bold text-slate-200">' + esc(order.statusLabel || order.status) + '</span>' +
      '</div>' +
      (sellerView ? '<div class="rounded-xl border border-white/10 bg-white/5 p-3 text-xs text-slate-300">' +
        '<div class="font-bold text-white">' + esc(order.buyerName) + '</div>' +
        '<a class="text-fuchsia-300 underline" href="tel:' + esc(String(order.buyerPhone || '').replace(/[^+0-9]/g, '')) + '">' + esc(order.buyerPhone) + '</a></div>' : '') +
      timeline(order) +
      '<ul class="space-y-1 text-xs text-slate-300">' + items + '</ul>' +
      '<div class="flex justify-between border-t border-white/10 pt-2 text-sm font-extrabold text-white"><span>Total</span><span>' + esc(money(order.totalCents)) + '</span></div>' +
      (order.note ? '<p class="whitespace-pre-line break-words rounded-xl bg-white/5 p-3 text-xs text-slate-300"><span class="font-bold text-white">Note: </span>' + esc(order.note) + '</p>' : '') +
      (!sellerView && order.status !== 'CANCELLED' && order.status !== 'DELIVERED'
        ? '<p class="text-[11px] text-slate-400">Pay the seller directly. ' + esc((state.info && state.info.store && state.info.store.paymentInstructions) || '') + '</p>' : '') +
      (buttons ? '<div class="flex flex-wrap gap-2">' + buttons + '</div>' : '') +
    '</article>';
  }

  function renderOrders() {
    if (!user()) return signInPrompt('Sign in to see your orders.');
    if (!state.orders.length) return emptyBox('fa-receipt', 'You have no orders yet.');
    return '<div class="grid gap-3 lg:grid-cols-2">' + state.orders.map(function (order) { return orderCard(order, false); }).join('') + '</div>';
  }

  function renderSellerOrders() {
    var filter = '<div class="mb-3 flex flex-wrap items-center gap-2"><label for="storeOrderFilter" class="text-[11px] font-semibold text-slate-400">Show</label>' +
      '<select id="storeOrderFilter" data-store-input="orderFilter" class="obsidian-input rounded-xl px-3 py-2 text-xs text-white">' +
      [['', 'All orders'], ['NEW', 'New'], ['CONFIRMED', 'Confirmed'], ['IN_PROGRESS', 'Being made'], ['READY', 'Ready'], ['DELIVERED', 'Delivered'], ['CANCELLED', 'Cancelled']]
        .map(function (entry) { return '<option value="' + entry[0] + '"' + (entry[0] === state.orderFilter ? ' selected' : '') + '>' + entry[1] + '</option>'; }).join('') +
      '</select><button type="button" data-store-action="refresh" class="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-bold text-slate-200"><i class="fa-solid fa-rotate mr-1.5" aria-hidden="true"></i>Refresh</button></div>';
    var list = state.manageOrders.filter(function (order) { return !state.orderFilter || order.status === state.orderFilter; });
    if (!list.length) return filter + emptyBox('fa-inbox', 'No orders here yet.');
    return filter + '<div class="grid gap-3 lg:grid-cols-2">' + list.map(function (order) { return orderCard(order, true); }).join('') + '</div>';
  }

  async function runOrderAction(id, action, asSeller) {
    var body = { action: action };
    if (action === 'CANCEL') {
      if (asSeller) {
        var reason = window.prompt('Why are you cancelling this order? The buyer will see this.');
        if (reason === null) return;
        if (!reason.trim()) {
          showMessage('Write a reason so the buyer knows why.', 'error');
          return;
        }
        body.reason = reason.trim().slice(0, 300);
      } else if (!window.confirm('Cancel this order?')) {
        return;
      }
    }
    try {
      await api('/api/store/orders/' + encodeURIComponent(id), { method: 'PATCH', body: body });
      showMessage('Order updated.');
    } catch (error) {
      showMessage(error.message || 'The order could not be updated.', 'error');
    }
    await loadTabData().catch(function () { /* keep old list */ });
    render();
  }

  // ---------- Manage products ----------

  function renderManage() {
    var editing = state.editingId ? state.manageProducts.find(function (product) { return product.id === state.editingId; }) : null;
    var p = editing || { title: '', description: '', category: 'DESIGN', priceCents: '', stock: null, isPublished: true };
    var categories = (state.info && state.info.categories) || Object.keys(CATEGORY_LABELS);
    var preview = state.pendingImage
      ? '<img src="data:' + esc(state.pendingImage.mime) + ';base64,' + esc(state.pendingImage.data) + '" alt="New photo" class="h-20 w-20 rounded-lg object-cover">'
      : (editing && editing.imageUrl && !state.removeImage ? productImage(editing, 'h-20 w-20 rounded-lg') : '');
    var form = '<form data-store-form="product" class="glass-panel space-y-3 rounded-2xl border border-white/10 p-4">' +
      '<h3 class="text-sm font-extrabold text-white">' + (editing ? 'Edit product' : 'Add a product') + '</h3>' +
      '<label class="block text-[11px] font-semibold text-slate-400">Name<input name="title" required maxlength="120" value="' + esc(p.title) + '" class="obsidian-input mt-1 w-full rounded-xl px-3 py-2.5 text-xs text-white"></label>' +
      '<div class="grid grid-cols-2 gap-2">' +
        '<label class="block text-[11px] font-semibold text-slate-400">Category<select name="category" class="obsidian-input mt-1 w-full rounded-xl px-3 py-2.5 text-xs text-white">' +
          categories.map(function (category) { return '<option value="' + esc(category) + '"' + (category === p.category ? ' selected' : '') + '>' + esc(CATEGORY_LABELS[category] || category) + '</option>'; }).join('') +
        '</select></label>' +
        '<label class="block text-[11px] font-semibold text-slate-400">Price (US dollars)<input name="price" type="number" required min="0.01" max="100000" step="0.01" value="' + (p.priceCents === '' ? '' : esc((p.priceCents / 100).toFixed(2))) + '" class="obsidian-input mt-1 w-full rounded-xl px-3 py-2.5 text-xs text-white"></label>' +
      '</div>' +
      '<label class="block text-[11px] font-semibold text-slate-400">How many you have (leave empty for no limit)<input name="stock" type="number" min="0" max="100000" step="1" value="' + (p.stock === null ? '' : esc(p.stock)) + '" class="obsidian-input mt-1 w-full rounded-xl px-3 py-2.5 text-xs text-white"></label>' +
      '<label class="block text-[11px] font-semibold text-slate-400">Description<textarea name="description" rows="4" maxlength="2000" class="obsidian-input mt-1 w-full rounded-xl px-3 py-2.5 text-xs text-white">' + esc(p.description) + '</textarea></label>' +
      '<div class="space-y-2"><span class="block text-[11px] font-semibold text-slate-400">Photo</span>' +
        '<div class="flex flex-wrap items-center gap-3">' + preview +
          '<label class="cursor-pointer rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-bold text-slate-200"><i class="fa-solid fa-image mr-1.5" aria-hidden="true"></i>Choose photo' +
            '<input data-store-input="image" type="file" accept="image/png,image/jpeg,image/webp" class="sr-only"></label>' +
          (preview ? '<button type="button" data-store-action="clearImage" class="text-xs font-bold text-rose-300 underline">Remove photo</button>' : '') +
        '</div></div>' +
      '<label class="flex items-center gap-2 text-xs font-semibold text-slate-300"><input name="isPublished" type="checkbox"' + (p.isPublished ? ' checked' : '') + ' class="h-4 w-4 accent-[#C909E6]"> Show this product in the shop</label>' +
      '<div class="flex flex-wrap gap-2"><button type="submit" class="rounded-xl bg-[#C909E6] px-4 py-2.5 text-xs font-bold text-white">' + (editing ? 'Save changes' : 'Add product') + '</button>' +
      (editing ? '<button type="button" data-store-action="cancelEdit" class="rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-xs font-bold text-slate-200">Cancel</button>' : '') + '</div>' +
    '</form>';
    var list = state.manageProducts.length ? state.manageProducts.map(function (product) {
      return '<div class="flex items-center gap-3 rounded-xl border border-white/10 bg-white/5 p-3">' +
        productImage(product, 'h-14 w-14 shrink-0 rounded-lg') +
        '<div class="min-w-0 flex-1"><div class="truncate text-xs font-bold text-white">' + esc(product.title) + '</div>' +
        '<div class="text-[11px] text-slate-400">' + esc(money(product.priceCents)) + ' · ' + esc(stockText(product.stock)) + ' · ' +
          (product.isPublished ? '<span class="text-[#E27BF5] store-ok-text">In the shop</span>' : '<span class="text-amber-300">Hidden</span>') + '</div>' +
        '<div class="mt-2 flex flex-wrap gap-1.5">' +
          '<button type="button" data-store-action="edit" data-id="' + esc(product.id) + '" class="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-[11px] font-bold text-slate-200">Edit</button>' +
          '<button type="button" data-store-action="togglePublish" data-id="' + esc(product.id) + '" class="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-[11px] font-bold text-slate-200">' + (product.isPublished ? 'Hide' : 'Show in shop') + '</button>' +
          '<button type="button" data-store-action="deleteProduct" data-id="' + esc(product.id) + '" class="rounded-lg border border-rose-500/40 bg-rose-500/10 px-2.5 py-1.5 text-[11px] font-bold text-rose-300">Delete</button>' +
        '</div></div></div>';
    }).join('') : emptyBox('fa-box-open', 'No products yet. Add your first one.');
    return '<div class="grid gap-4 lg:grid-cols-[22rem_1fr]">' + form + '<div class="space-y-2">' + list + '</div></div>';
  }

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result).split(',')[1] || ''); };
      reader.onerror = function () { reject(new Error('The photo could not be read.')); };
      reader.readAsDataURL(blob);
    });
  }

  function loadImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var image = new Image();
      image.onload = function () { URL.revokeObjectURL(url); resolve(image); };
      image.onerror = function () { URL.revokeObjectURL(url); reject(new Error('This file is not a photo we can use.')); };
      image.src = url;
    });
  }

  async function resizeImage(file) {
    var limit = Math.min(MAX_UPLOAD_BYTES, Number(state.info && state.info.maxImageBytes) || MAX_UPLOAD_BYTES);
    var image = await loadImage(file);
    var maxSide = 1200;
    var quality = 0.85;
    for (var attempt = 0; attempt < 10; attempt += 1) {
      var scale = Math.min(1, maxSide / Math.max(image.naturalWidth || 1, image.naturalHeight || 1));
      var canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round((image.naturalWidth || 1) * scale));
      canvas.height = Math.max(1, Math.round((image.naturalHeight || 1) * scale));
      var context = canvas.getContext('2d');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      var blob = await new Promise(function (resolve) { canvas.toBlob(resolve, 'image/jpeg', quality); });
      if (blob && blob.size <= limit) return { mime: 'image/jpeg', data: await blobToBase64(blob) };
      if (quality > 0.55) quality -= 0.1;
      else maxSide = Math.round(maxSide * 0.8);
    }
    throw new Error('This photo is too large. Choose a smaller one.');
  }

  async function saveProduct(form) {
    var body = {
      title: form.title.value,
      category: form.category.value,
      price: Number(form.price.value),
      stock: form.stock.value === '' ? null : Number(form.stock.value),
      description: form.description.value,
      isPublished: form.isPublished.checked
    };
    if (state.pendingImage) {
      body.imageData = state.pendingImage.data;
      body.imageMime = state.pendingImage.mime;
    } else if (state.removeImage && state.editingId) {
      body.removeImage = true;
    }
    try {
      if (state.editingId) {
        await api('/api/store/products/' + encodeURIComponent(state.editingId), { method: 'PATCH', body: body });
        showMessage('Product saved.');
      } else {
        await api('/api/store/products', { method: 'POST', body: body });
        showMessage('Product added.');
      }
      state.editingId = null;
      state.pendingImage = null;
      state.removeImage = false;
      await loadTabData();
    } catch (error) {
      showMessage(error.message || 'The product could not be saved.', 'error');
    }
    render();
  }

  async function togglePublish(id) {
    var product = state.manageProducts.find(function (entry) { return entry.id === id; });
    if (!product) return;
    try {
      await api('/api/store/products/' + encodeURIComponent(id), { method: 'PATCH', body: { isPublished: !product.isPublished } });
      showMessage(product.isPublished ? 'Product hidden from the shop.' : 'Product is now in the shop.');
      await loadTabData();
    } catch (error) {
      showMessage(error.message, 'error');
    }
    render();
  }

  async function deleteProduct(id) {
    var product = state.manageProducts.find(function (entry) { return entry.id === id; });
    if (!product || !window.confirm('Delete "' + product.title + '"? Past orders keep their details.')) return;
    try {
      await api('/api/store/products/' + encodeURIComponent(id), { method: 'DELETE' });
      if (state.editingId === id) state.editingId = null;
      showMessage('Product deleted.');
      await loadTabData();
    } catch (error) {
      showMessage(error.message, 'error');
    }
    render();
  }

  // ---------- Sellers (Super Admin) ----------

  function renderSellers() {
    var list = state.sellers.length ? state.sellers.map(function (seller) {
      return '<div class="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/5 p-3">' +
        '<div class="min-w-0"><div class="truncate text-xs font-bold text-white">' + esc(seller.name) + '</div>' +
        '<div class="truncate text-[11px] text-slate-400">' + esc(seller.email) + (seller.phone ? ' · ' + esc(seller.phone) : '') + '</div></div>' +
        '<button type="button" data-store-action="removeSeller" data-id="' + esc(seller.id) + '" class="shrink-0 rounded-lg border border-rose-500/40 bg-rose-500/10 px-2.5 py-1.5 text-[11px] font-bold text-rose-300">Remove</button></div>';
    }).join('') : emptyBox('fa-user-tie', 'No sellers yet. Add the ' + storeName() + ' account.');
    var form = '<form data-store-form="seller" class="glass-panel space-y-3 rounded-2xl border border-white/10 p-4">' +
      '<h3 class="text-sm font-extrabold text-white">Add a seller</h3>' +
      '<p class="text-[11px] text-slate-400">Sellers can add products and handle orders. Enter the email of an existing account, or also fill in a name and password to create a new account.</p>' +
      '<label class="block text-[11px] font-semibold text-slate-400">Email<input name="email" type="email" required maxlength="254" class="obsidian-input mt-1 w-full rounded-xl px-3 py-2.5 text-xs text-white"></label>' +
      '<label class="block text-[11px] font-semibold text-slate-400">Name (new account only)<input name="name" maxlength="120" class="obsidian-input mt-1 w-full rounded-xl px-3 py-2.5 text-xs text-white"></label>' +
      '<label class="block text-[11px] font-semibold text-slate-400">Password, at least 12 characters (new account only)<input name="password" type="password" minlength="12" maxlength="256" autocomplete="new-password" class="obsidian-input mt-1 w-full rounded-xl px-3 py-2.5 text-xs text-white"></label>' +
      '<button type="submit" class="rounded-xl bg-[#C909E6] px-4 py-2.5 text-xs font-bold text-white">Add seller</button></form>';
    return '<div class="grid gap-4 lg:grid-cols-[22rem_1fr]">' + form + '<div class="space-y-2">' + list + '</div></div>';
  }

  async function addSeller(form) {
    var body = { email: form.email.value };
    if (form.password.value || form.name.value) {
      body.name = form.name.value;
      body.password = form.password.value;
    }
    try {
      var result = await api('/api/store/sellers', { method: 'POST', body: body });
      state.sellers = result.sellers || state.sellers;
      showMessage('Seller added.');
    } catch (error) {
      showMessage(error.message, 'error');
    }
    render();
  }

  async function removeSeller(id) {
    var seller = state.sellers.find(function (entry) { return entry.id === id; });
    if (!seller || !window.confirm('Remove ' + seller.name + ' as a seller? Their account stays.')) return;
    try {
      var result = await api('/api/store/sellers', { method: 'DELETE', body: { userId: id } });
      state.sellers = result.sellers || [];
      showMessage('Seller removed.');
    } catch (error) {
      showMessage(error.message, 'error');
    }
    render();
  }

  // ---------- events ----------

  async function switchTab(tab) {
    state.tab = tab;
    showMessage(null);
    render();
    try {
      await loadTabData();
    } catch (error) {
      showMessage(error.message, 'error');
    }
    render();
  }

  function onModalClick(event) {
    var modal = document.getElementById('storePluginModal');
    if (event.target === modal) {
      closeStore();
      return;
    }
    var target = event.target.closest('[data-store-action]');
    if (!target || !modal.contains(target)) return;
    var action = target.getAttribute('data-store-action');
    var id = target.getAttribute('data-id');
    if (action === 'close') closeStore();
    else if (action === 'tab') switchTab(target.getAttribute('data-tab'));
    else if (action === 'add') addToCart(id);
    else if (action === 'qty') changeQty(id, Number(target.getAttribute('data-delta')));
    else if (action === 'remove') { delete state.cart[id]; saveCart(); render(); }
    else if (action === 'signin') {
      closeStore();
      try { if (typeof window.openAuthGate === 'function') window.openAuthGate('login'); } catch (error) { /* ignore */ }
    }
    else if (action === 'orderAction') runOrderAction(id, target.getAttribute('data-order-action'), target.getAttribute('data-seller') === '1');
    else if (action === 'refresh') switchTab(state.tab);
    else if (action === 'edit') { state.editingId = id; state.pendingImage = null; state.removeImage = false; render(); document.getElementById('storePluginBody').scrollTop = 0; }
    else if (action === 'cancelEdit') { state.editingId = null; state.pendingImage = null; state.removeImage = false; render(); }
    else if (action === 'clearImage') { state.pendingImage = null; state.removeImage = true; render(); }
    else if (action === 'togglePublish') togglePublish(id);
    else if (action === 'deleteProduct') deleteProduct(id);
    else if (action === 'removeSeller') removeSeller(id);
  }

  function onModalInput(event) {
    var name = event.target.getAttribute && event.target.getAttribute('data-store-input');
    if (name === 'search') {
      state.search = event.target.value;
      refreshProductList();
    }
  }

  async function onModalChange(event) {
    var name = event.target.getAttribute && event.target.getAttribute('data-store-input');
    if (name === 'category') { state.category = event.target.value; refreshProductList(); }
    else if (name === 'orderFilter') { state.orderFilter = event.target.value; render(); }
    else if (name === 'image') {
      var file = event.target.files && event.target.files[0];
      if (!file) return;
      var form = event.target.closest('form');
      var draft = form ? {
        title: form.title.value, category: form.category.value, price: form.price.value,
        stock: form.stock.value, description: form.description.value, isPublished: form.isPublished.checked
      } : null;
      try {
        state.pendingImage = await resizeImage(file);
        state.removeImage = false;
      } catch (error) {
        showMessage(error.message, 'error');
      }
      render();
      // Keep what the seller already typed.
      var next = document.querySelector('#storePluginBody form[data-store-form="product"]');
      if (next && draft) {
        next.title.value = draft.title;
        next.category.value = draft.category;
        next.price.value = draft.price;
        next.stock.value = draft.stock;
        next.description.value = draft.description;
        next.isPublished.checked = draft.isPublished;
      }
    }
  }

  async function onModalSubmit(event) {
    var form = event.target;
    var kind = form.getAttribute('data-store-form');
    if (!kind) return;
    event.preventDefault();
    if (state.busy) return;
    state.busy = true;
    var button = form.querySelector('[type="submit"]');
    if (button) button.disabled = true;
    try {
      if (kind === 'order') await placeOrder(form);
      else if (kind === 'product') await saveProduct(form);
      else if (kind === 'seller') await addSeller(form);
    } finally {
      state.busy = false;
      if (button && document.body.contains(button)) button.disabled = false;
    }
  }

  // ---------- notifications and deep links ----------

  function openOrder(orderId) {
    state.focusOrderId = orderId;
    loadInfo().catch(function () { /* openStore shows the error */ }).then(function () {
      var tab = 'orders';
      if (isSeller()) {
        tab = 'sellerOrders';
        api('/api/store/orders').then(function (result) {
          if ((result.orders || []).some(function (order) { return order.id === orderId; })) openStore('orders');
          else openStore('sellerOrders');
        }).catch(function () { openStore(tab); });
        return;
      }
      openStore(tab);
    });
  }

  function hookNotifications() {
    var original = window.openNotification;
    if (typeof original !== 'function' || original.__storeWrapped) return;
    var wrapped = async function (notificationId) {
      var list = null;
      try { list = typeof notifications !== 'undefined' ? notifications : null; } catch (error) { list = null; }
      var item = Array.isArray(list) ? list.find(function (entry) { return entry.id === notificationId; }) : null;
      if (item && /^STORE_ORDER/.test(item.type || '')) {
        try { if (typeof window.setNotificationRead === 'function') await window.setNotificationRead(notificationId, true); } catch (error) { /* ignore */ }
        try { if (typeof window.closeNotificationCenter === 'function') window.closeNotificationCenter(); } catch (error) { /* ignore */ }
        var orderId = null;
        try { orderId = new URL(item.href || '/', window.location.origin).searchParams.get('storeOrder'); } catch (error) { orderId = null; }
        if (orderId) openOrder(orderId);
        else openStore('orders');
        return;
      }
      return original.apply(this, arguments);
    };
    wrapped.__storeWrapped = true;
    window.openNotification = wrapped;
  }

  function handleDeepLink() {
    var params;
    try { params = new URLSearchParams(window.location.search); } catch (error) { return; }
    var orderId = params.get('storeOrder');
    var openShop = params.get('shop') === '1';
    if (!orderId && !openShop) return;
    try {
      var clean = new URL(window.location.href);
      clean.searchParams.delete('storeOrder');
      clean.searchParams.delete('shop');
      window.history.replaceState(window.history.state, '', clean.toString());
    } catch (error) { /* ignore */ }
    if (orderId && !/^[A-Za-z0-9-]{1,80}$/.test(orderId)) return;
    // Wait for the app to finish signing the user in (up to about 8 seconds).
    var tries = 0;
    var timer = setInterval(function () {
      tries += 1;
      var booting = document.documentElement.classList.contains('app-booting');
      if ((!booting && (user() || tries > 8)) || tries > 32) {
        clearInterval(timer);
        if (orderId) openOrder(orderId);
        else openStore('products');
      }
    }, 250);
  }

  function start() {
    var attempts = 0;
    if (!injectNav()) {
      var timer = setInterval(function () {
        attempts += 1;
        if (injectNav() || attempts > 60) clearInterval(timer);
      }, 500);
    }
    hookNotifications();
    setTimeout(hookNotifications, 1500);
    api('/api/store/info').then(function (info) { state.info = info; updateNavLabels(); }).catch(function () { /* shop info loads again on open */ });
    handleDeepLink();
  }

  window.openStorePlugin = openStore;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
