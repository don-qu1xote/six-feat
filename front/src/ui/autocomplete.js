// ════════════════════════════════════════════════════════════════════════════
// ui/autocomplete.js — Genius-backed artist autocomplete (createGeniusAc/
//                      attachGeniusAutocomplete) and in-graph node
//                      autocomplete with Genius fallback (attachNodeAutocomplete)
// ════════════════════════════════════════════════════════════════════════════
import { State } from "../state/state.js";
import { escapeHtml, placeholderFor, debounce } from "../state/helpers.js";
import { apiFetch } from "../api/net.js";
// [SF-WEB-41] Дропдаун рендерится в общий #overlay-root с anchored-
// позиционированием от инпута, а не внутри своего контейнера, где его режет
// overflow/зажимает stacking-context карточки. open/closeDropdown = класс
// .open + перенос в/из overlay-root; anchorDropdown один раз связывает
// дропдаун с его инпутом-якорем (см. ui/overlay-root.js).
import { openDropdown, closeDropdown, anchorDropdown } from "./overlay-root.js";

// ТЗ-208: debounce уже защищает от лишних запросов при паузах в наборе, но
// не отменяет уже улетевший in-flight fetch, если пользователь печатает
// быстро — старый ответ может прийти позже нового и перезаписать dropdown
// устаревшими данными (race condition). runServerPath уже решает это через
// State._pathAbortController; здесь заводим свой AbortController по той же
// схеме и отменяем предыдущий запрос перед каждым новым fetch.
export function createGeniusAc() {
  let _acController = null;

  return debounce(async (query, dropdownEl, onSelect) => {
    if (!query || query.length < 2) { closeDropdown(dropdownEl); return; }

    if (_acController) _acController.abort();
    _acController = new AbortController();
    const signal = _acController.signal;

    dropdownEl.innerHTML = `<div class="ac-spinner">Searching…</div>`;
    openDropdown(dropdownEl);
    try {
      const res  = await apiFetch(`/api/v1/search?q=${encodeURIComponent(query)}`, { signal });
      const data = res.ok ? await res.json() : null;
      const candidates = data?.candidates || [];

      if (!candidates.length) { closeDropdown(dropdownEl); return; }

      dropdownEl.innerHTML = candidates.slice(0, 6).map(c => `
        <div class="ac-item" data-name="${escapeHtml(c.name)}" data-image="${escapeHtml(c.image || "")}"
             data-id="${c.id != null ? escapeHtml(String(c.id)) : ""}" role="option">
          <img class="ac-avatar" src="${escapeHtml(c.image || placeholderFor(c.name, false))}"
              data-fallback="${escapeHtml(placeholderFor(c.name, false))}" alt="" />
          <div class="ac-info">
            <span class="ac-name truncate" title="${escapeHtml(c.name)}">${escapeHtml(c.name)}</span>
            ${c.score != null && c.score < 1
              ? `<span class="ac-hint">${Math.round(c.score * 100)}%</span>`
              : ""}
          </div>
        </div>
      `).join("");

      dropdownEl.querySelectorAll(".ac-item").forEach(item => {
        item.addEventListener("mousedown", e => {
          e.preventDefault();
          const name = item.getAttribute("data-name");
          // [design: real graph reuse] Second/third (optional) args — the
          // real Genius photo URL and numeric artist id /api/v1/search
          // already returns per candidate (search_handler.cpp's
          // cb["id"]). Existing callers that only declare `name => …`
          // simply never see them; onSelect(name) already worked and
          // keeps working.
          const image = item.getAttribute("data-image") || null;
          const idAttr = item.getAttribute("data-id");
          const id = idAttr ? Number(idAttr) : null;
          closeDropdown(dropdownEl);
          onSelect(name, image, id);
        });
      });
    } catch (err) {
      if (err.name === "AbortError") return; // отменено более новым вводом — не трогаем dropdown
      closeDropdown(dropdownEl);
    }
  }, 300);
}

export function attachGeniusAutocomplete(inputEl, dropdownEl, onSelect, geniusAcFn) {
  const _ac = geniusAcFn || createGeniusAc();
  anchorDropdown(dropdownEl, inputEl); // [SF-WEB-41] дропдаун позиционируется от этого инпута в overlay-root

  function showHistoryDropdown() {
    const items = State.history.slice(0, 5);
    // [SF-GAME-51] Пустая история — НЕ повод открывать дропдаун. Раньше при
    // фокусе на поле выезжала панель во всю его ширину с единственной
    // надписью «No recent searches»: у любого, кто зашёл впервые, первым
    // впечатлением от главной был пустой блок под поиском, сообщающий, что
    // ничего нет. Нечего показать — ничего и не показываем; поле остаётся
    // тем, чем и было, с плейсхолдером-подсказкой и чипсами «Try one of
    // these» ниже.
    if (!items.length) { closeDropdown(dropdownEl); return; }
    // [SF-WEB-59] History rows previously skipped the .ac-avatar image
    // entirely — with .ac-item's flex layout (avatar + gap + info), that
    // made history rows visibly narrower/misaligned next to live
    // suggestion rows (which always render one, real photo or
    // placeholderFor fallback). History has no real photo either way, but
    // still gets the SAME placeholder fallback for layout consistency.
    dropdownEl.innerHTML = items.map(name => `
      <div class="ac-item ac-history" data-name="${escapeHtml(name)}">
        <img class="ac-avatar" src="${escapeHtml(placeholderFor(name, false))}" alt="" />
        <div class="ac-info">
          <span class="ac-name truncate" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
        </div>
      </div>
    `).join("");
    openDropdown(dropdownEl);

    dropdownEl.querySelectorAll(".ac-history").forEach(item => {
      item.addEventListener("mousedown", e => {
        e.preventDefault();
        const name = item.getAttribute("data-name");
        closeDropdown(dropdownEl);
        inputEl.value = name;
        onSelect(name);
      });
    });
  }

  inputEl.addEventListener("focus", () => {
    if (!inputEl.value.trim()) showHistoryDropdown();
  });

  inputEl.addEventListener("input", () => {
    const val = inputEl.value.trim();
    if (val) {
      _ac(val, dropdownEl, onSelect);
    } else {
      showHistoryDropdown();
    }
  });

  inputEl.addEventListener("blur", () => {
    setTimeout(() => closeDropdown(dropdownEl), 150);
  });

  inputEl.addEventListener("keydown", e => {
    if (e.key === "Escape") closeDropdown(dropdownEl);
    if (e.key === "ArrowDown") {
      const first = dropdownEl.querySelector(".ac-item");
      if (first) { first.classList.add("ac-active"); first.focus(); }
    }
    // [design: typed entry is primary] Enter here means the caller is
    // committing whatever was typed, not picking a suggestion (picking a
    // suggestion moves focus into dropdownEl first — see ArrowDown above
    // and dropdownEl's own keydown handler below). A still-pending debounced
    // search must not reopen the dropdown after that commit already moved
    // the UI on, so cancel it along with closing whatever's currently shown.
    if (e.key === "Enter") { _ac.cancel?.(); closeDropdown(dropdownEl); }
  });

  dropdownEl.addEventListener("keydown", e => {
    const items = [...dropdownEl.querySelectorAll(".ac-item")];
    const idx   = items.findIndex(i => i === document.activeElement);
    if (e.key === "ArrowDown" && idx < items.length - 1) items[idx + 1].focus();
    if (e.key === "ArrowUp"   && idx > 0)                items[idx - 1].focus();
    if (e.key === "ArrowUp"   && idx === 0)              inputEl.focus();
    if (e.key === "Enter" && idx >= 0) items[idx].dispatchEvent(new MouseEvent("mousedown"));
    if (e.key === "Escape") { closeDropdown(dropdownEl); inputEl.focus(); }
  });
}

// Task 4: path inputs — node autocomplete (primary) with Genius fallback
export function attachNodeAutocomplete(inputEl, dropdownEl, onSelect) {
  const _genius = createGeniusAc();
  anchorDropdown(dropdownEl, inputEl); // [SF-WEB-41] дропдаун позиционируется от этого инпута в overlay-root

  const _showNodes = debounce(() => {
    const q = inputEl.value.trim().toLowerCase();
    if (!q) { closeDropdown(dropdownEl); return; }

    const matches = State.graphNodes
      .filter(n => n.name.toLowerCase().includes(q))
      .slice(0, 8);

    // Exact (case-insensitive) match to a single node — the value already
    // unambiguously names a graph node, so auto-resolve it instead of
    // leaving the dropdown open. Without this, a fully-typed exact name
    // (e.g. filled programmatically, or pasted) leaves the suggestion
    // card floating over whatever sits below the input — since selecting
    // it requires a mousedown that its own listener preventDefault()s (to
    // dodge the input's blur handler), nothing short of that specific
    // click can ever close it, so any element the card happens to overlap
    // becomes unclickable until the user clicks the card itself first.
    const exact = matches.length === 1 && matches[0].name.toLowerCase() === q ? matches[0] : null;
    if (exact) {
      closeDropdown(dropdownEl);
      onSelect(exact.name);
      return;
    }

    if (matches.length) {
      dropdownEl.innerHTML = matches.map(n => {
        const img = n.imageUrl || placeholderFor(n.name, n.isSeed);
        return `<div class="ac-item" data-name="${escapeHtml(n.name)}" role="option">
          <img class="ac-avatar" src="${escapeHtml(img)}"
               data-fallback="${escapeHtml(placeholderFor(n.name, false))}" alt="" />
          <div class="ac-info"><div class="ac-name truncate" title="${escapeHtml(n.name)}">${escapeHtml(n.name)}</div></div>
        </div>`;
      }).join("");
      dropdownEl.querySelectorAll(".ac-item").forEach(item => {
        item.addEventListener("mousedown", e => {
          e.preventDefault();
          const name = item.getAttribute("data-name");
          inputEl.value = name;
          closeDropdown(dropdownEl);
          onSelect(name);
        });
      });
      openDropdown(dropdownEl);
    } else {
      // Fallback to Genius for names not in canvas
      _genius(inputEl.value.trim(), dropdownEl, name => {
        inputEl.value = name;
        onSelect(name);
      });
    }
  }, 80);

  inputEl.addEventListener("input", _showNodes);
  inputEl.addEventListener("focus", _showNodes);
  inputEl.addEventListener("blur",  () => { setTimeout(() => closeDropdown(dropdownEl), 150); });
  inputEl.addEventListener("keydown", e => {
    if (e.key === "Escape") closeDropdown(dropdownEl);
  });
}
