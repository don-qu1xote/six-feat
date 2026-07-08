// ════════════════════════════════════════════════════════════════════════════
// ui/autocomplete.js — Genius-backed artist autocomplete (createGeniusAc/
//                      attachGeniusAutocomplete) and in-graph node
//                      autocomplete with Genius fallback (attachNodeAutocomplete)
// ════════════════════════════════════════════════════════════════════════════
import { State } from "../state/state.js";
import { escapeHtml, placeholderFor, debounce } from "../state/helpers.js";
import { apiFetch } from "../api/net.js";

// ТЗ-208: debounce уже защищает от лишних запросов при паузах в наборе, но
// не отменяет уже улетевший in-flight fetch, если пользователь печатает
// быстро — старый ответ может прийти позже нового и перезаписать dropdown
// устаревшими данными (race condition). runServerPath уже решает это через
// State._pathAbortController; здесь заводим свой AbortController по той же
// схеме и отменяем предыдущий запрос перед каждым новым fetch.
export function createGeniusAc() {
  let _acController = null;

  return debounce(async (query, dropdownEl, onSelect) => {
    if (!query || query.length < 2) { dropdownEl.classList.remove("open"); return; }

    if (_acController) _acController.abort();
    _acController = new AbortController();
    const signal = _acController.signal;

    dropdownEl.innerHTML = `<div class="ac-spinner">Searching…</div>`;
    dropdownEl.classList.add("open");
    try {
      const res  = await apiFetch(`/api/v1/search?q=${encodeURIComponent(query)}`, { signal });
      const data = res.ok ? await res.json() : null;
      const candidates = data?.candidates || [];

      if (!candidates.length) { dropdownEl.classList.remove("open"); return; }

      dropdownEl.innerHTML = candidates.slice(0, 6).map(c => `
        <div class="ac-item" data-name="${escapeHtml(c.name)}" role="option">
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
          dropdownEl.classList.remove("open");
          onSelect(name);
        });
      });
    } catch (err) {
      if (err.name === "AbortError") return; // отменено более новым вводом — не трогаем dropdown
      dropdownEl.classList.remove("open");
    }
  }, 300);
}

export function attachGeniusAutocomplete(inputEl, dropdownEl, onSelect, geniusAcFn) {
  const _ac = geniusAcFn || createGeniusAc();

  function showHistoryDropdown() {
    const items = State.history.slice(0, 5);
    if (!items.length) {
      dropdownEl.innerHTML = `<div class="ac-spinner">No recent searches</div>`;
      dropdownEl.classList.add("open");
      return;
    }
    dropdownEl.innerHTML = items.map(name => `
      <div class="ac-item ac-history" data-name="${escapeHtml(name)}">
        <div class="ac-info">
          <span class="ac-name truncate" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
        </div>
      </div>
    `).join("");
    dropdownEl.classList.add("open");

    dropdownEl.querySelectorAll(".ac-history").forEach(item => {
      item.addEventListener("mousedown", e => {
        e.preventDefault();
        const name = item.getAttribute("data-name");
        dropdownEl.classList.remove("open");
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
    setTimeout(() => dropdownEl.classList.remove("open"), 150);
  });

  inputEl.addEventListener("keydown", e => {
    if (e.key === "Escape") dropdownEl.classList.remove("open");
    if (e.key === "ArrowDown") {
      const first = dropdownEl.querySelector(".ac-item");
      if (first) { first.classList.add("ac-active"); first.focus(); }
    }
  });

  dropdownEl.addEventListener("keydown", e => {
    const items = [...dropdownEl.querySelectorAll(".ac-item")];
    const idx   = items.findIndex(i => i === document.activeElement);
    if (e.key === "ArrowDown" && idx < items.length - 1) items[idx + 1].focus();
    if (e.key === "ArrowUp"   && idx > 0)                items[idx - 1].focus();
    if (e.key === "ArrowUp"   && idx === 0)              inputEl.focus();
    if (e.key === "Enter" && idx >= 0) items[idx].dispatchEvent(new MouseEvent("mousedown"));
    if (e.key === "Escape") { dropdownEl.classList.remove("open"); inputEl.focus(); }
  });
}

// Task 4: path inputs — node autocomplete (primary) with Genius fallback
export function attachNodeAutocomplete(inputEl, dropdownEl, onSelect) {
  const _genius = createGeniusAc();

  const _showNodes = debounce(() => {
    const q = inputEl.value.trim().toLowerCase();
    if (!q) { dropdownEl.classList.remove("open"); return; }

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
      dropdownEl.classList.remove("open");
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
          dropdownEl.classList.remove("open");
          onSelect(name);
        });
      });
      dropdownEl.classList.add("open");
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
  inputEl.addEventListener("blur",  () => { setTimeout(() => dropdownEl.classList.remove("open"), 150); });
  inputEl.addEventListener("keydown", e => {
    if (e.key === "Escape") dropdownEl.classList.remove("open");
  });
}
