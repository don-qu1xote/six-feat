import { State } from "../state/state.js";
import { escapeHtml, placeholderFor, debounce } from "../state/helpers.js";
import { apiFetch } from "../api/net.js";
import { openDropdown, closeDropdown, anchorDropdown } from "./overlay-root.js";
import { t } from "../i18n/i18n.js";

export function createGeniusAc() {
  let _acController = null;

  return debounce(async (query, dropdownEl, onSelect) => {
    if (!query || query.length < 2) {
      closeDropdown(dropdownEl);
      return;
    }

    if (_acController) _acController.abort();
    _acController = new AbortController();
    const signal = _acController.signal;

    dropdownEl.innerHTML = `<div class="ac-spinner">${escapeHtml(t("autocomplete.searching"))}</div>`;
    openDropdown(dropdownEl);
    try {
      const res = await apiFetch(`/api/v1/search?q=${encodeURIComponent(query)}`, { signal });
      const data = res.ok ? await res.json() : null;
      const candidates = data?.candidates || [];

      if (!candidates.length) {
        closeDropdown(dropdownEl);
        return;
      }

      dropdownEl.innerHTML = candidates
        .slice(0, 6)
        .map(
          (c) => `
        <div class="ac-item" data-name="${escapeHtml(c.name)}" data-image="${escapeHtml(c.image || "")}"
             data-id="${c.id != null ? escapeHtml(String(c.id)) : ""}" role="option">
          <img class="ac-avatar" src="${escapeHtml(c.image || placeholderFor(c.name, false))}"
              data-fallback="${escapeHtml(placeholderFor(c.name, false))}" alt="" />
          <div class="ac-info">
            <span class="ac-name truncate" title="${escapeHtml(c.name)}">${escapeHtml(c.name)}</span>
            ${
              c.score != null && c.score < 1
                ? `<span class="ac-hint">${Math.round(c.score * 100)}%</span>`
                : ""
            }
          </div>
        </div>
      `,
        )
        .join("");

      dropdownEl.querySelectorAll(".ac-item").forEach((item) => {
        item.addEventListener("mousedown", (e) => {
          e.preventDefault();
          const name = item.getAttribute("data-name");
          const image = item.getAttribute("data-image") || null;
          const idAttr = item.getAttribute("data-id");
          const id = idAttr ? Number(idAttr) : null;
          closeDropdown(dropdownEl);
          onSelect(name, image, id);
        });
      });
    } catch (err) {
      if (err.name === "AbortError") return;
      closeDropdown(dropdownEl);
    }
  }, 300);
}

// [SF-WEB-89] showHistory:false lets #hero-input skip this dropdown's own history list, since its chips row below already covers that (was a floating duplicate hiding the chips whenever focused-empty).
export function attachGeniusAutocomplete(
  inputEl,
  dropdownEl,
  onSelect,
  geniusAcFn,
  { showHistory = true } = {},
) {
  const _ac = geniusAcFn || createGeniusAc();
  anchorDropdown(dropdownEl, inputEl);
  function showHistoryDropdown() {
    if (!showHistory) {
      closeDropdown(dropdownEl);
      return;
    }
    const items = State.history.slice(0, 5);
    if (!items.length) {
      closeDropdown(dropdownEl);
      return;
    }
    dropdownEl.innerHTML = items
      .map(
        (name) => `
      <div class="ac-item ac-history" data-name="${escapeHtml(name)}">
        <img class="ac-avatar" src="${escapeHtml(placeholderFor(name, false))}" alt="" />
        <div class="ac-info">
          <span class="ac-name truncate" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
        </div>
      </div>
    `,
      )
      .join("");
    openDropdown(dropdownEl);

    dropdownEl.querySelectorAll(".ac-history").forEach((item) => {
      item.addEventListener("mousedown", (e) => {
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

  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDropdown(dropdownEl);
    if (e.key === "ArrowDown") {
      const first = dropdownEl.querySelector(".ac-item");
      if (first) {
        first.classList.add("ac-active");
        first.focus();
      }
    }
    if (e.key === "Enter") {
      _ac.cancel?.();
      closeDropdown(dropdownEl);
    }
  });

  dropdownEl.addEventListener("keydown", (e) => {
    const items = [...dropdownEl.querySelectorAll(".ac-item")];
    const idx = items.findIndex((i) => i === document.activeElement);
    if (e.key === "ArrowDown" && idx < items.length - 1) items[idx + 1].focus();
    if (e.key === "ArrowUp" && idx > 0) items[idx - 1].focus();
    if (e.key === "ArrowUp" && idx === 0) inputEl.focus();
    if (e.key === "Enter" && idx >= 0) items[idx].dispatchEvent(new MouseEvent("mousedown"));
    if (e.key === "Escape") {
      closeDropdown(dropdownEl);
      inputEl.focus();
    }
  });
}

export function attachNodeAutocomplete(inputEl, dropdownEl, onSelect) {
  const _genius = createGeniusAc();
  anchorDropdown(dropdownEl, inputEl);
  const _showNodes = debounce(() => {
    const q = inputEl.value.trim().toLowerCase();
    if (!q) {
      closeDropdown(dropdownEl);
      return;
    }

    const matches = State.graphNodes.filter((n) => n.name.toLowerCase().includes(q)).slice(0, 8);

    const exact = matches.length === 1 && matches[0].name.toLowerCase() === q ? matches[0] : null;
    if (exact) {
      closeDropdown(dropdownEl);
      onSelect(exact.name);
      return;
    }

    if (matches.length) {
      dropdownEl.innerHTML = matches
        .map((n) => {
          const img = n.imageUrl || placeholderFor(n.name, n.isSeed);
          return `<div class="ac-item" data-name="${escapeHtml(n.name)}" role="option">
          <img class="ac-avatar" src="${escapeHtml(img)}"
               data-fallback="${escapeHtml(placeholderFor(n.name, false))}" alt="" />
          <div class="ac-info"><div class="ac-name truncate" title="${escapeHtml(n.name)}">${escapeHtml(n.name)}</div></div>
        </div>`;
        })
        .join("");
      dropdownEl.querySelectorAll(".ac-item").forEach((item) => {
        item.addEventListener("mousedown", (e) => {
          e.preventDefault();
          const name = item.getAttribute("data-name");
          inputEl.value = name;
          closeDropdown(dropdownEl);
          onSelect(name);
        });
      });
      openDropdown(dropdownEl);
    } else {
      _genius(inputEl.value.trim(), dropdownEl, (name) => {
        inputEl.value = name;
        onSelect(name);
      });
    }
  }, 80);

  inputEl.addEventListener("input", _showNodes);
  inputEl.addEventListener("focus", _showNodes);
  inputEl.addEventListener("blur", () => {
    setTimeout(() => closeDropdown(dropdownEl), 150);
  });
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDropdown(dropdownEl);
  });
}
