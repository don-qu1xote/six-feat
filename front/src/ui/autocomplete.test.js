import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { State } from "../state/state.js";
import {
  attachGeniusAutocomplete,
  attachNodeAutocomplete,
  createGeniusAc,
} from "./autocomplete.js";
import { _resetOverlayRoot } from "./overlay-root.js";
import { apiFetch } from "../api/net.js";

vi.mock("../api/net.js", () => ({ apiFetch: vi.fn() }));

beforeEach(() => {
  document.body.innerHTML = "";
  _resetOverlayRoot();
  State.history = [];
  State.graphNodes = [];
});

function makeInputAndDropdown() {
  const input = document.createElement("input");
  const dd = document.createElement("div");
  dd.className = "ac-dropdown";
  document.body.append(input, dd);
  return { input, dd };
}

describe("attachGeniusAutocomplete — history rows (SF-WEB-59)", () => {
  it("renders an .ac-avatar image for a history row, same as a live suggestion row", () => {
    State.history = ["Kendrick Lamar", "Rosalía"];
    const { input, dd } = makeInputAndDropdown();
    attachGeniusAutocomplete(input, dd, () => {});

    input.dispatchEvent(new Event("focus"));

    const historyItems = dd.querySelectorAll(".ac-history");
    expect(historyItems.length).toBe(2);
    for (const item of historyItems) {
      const avatar = item.querySelector(".ac-avatar");
      expect(avatar).not.toBeNull();
      expect(avatar.getAttribute("src")).toBeTruthy();
    }
  });

  it("history rows use the same .ac-item structure (avatar + .ac-info) live suggestion rows use", () => {
    State.history = ["Gorillaz"];
    const { input, dd } = makeInputAndDropdown();
    attachGeniusAutocomplete(input, dd, () => {});
    input.dispatchEvent(new Event("focus"));

    const item = dd.querySelector(".ac-history");
    expect(item.classList.contains("ac-item")).toBe(true);
    expect(item.children[0].tagName).toBe("IMG");
    expect(item.children[0].classList.contains("ac-avatar")).toBe(true);
    expect(item.querySelector(".ac-info .ac-name")).not.toBeNull();
  });
});

describe("[SF-GAME-51] attachGeniusAutocomplete — пустая история", () => {
  it("не открывает дропдаун, когда показывать нечего", () => {
    State.history = [];
    const { input, dd } = makeInputAndDropdown();
    attachGeniusAutocomplete(input, dd, () => {});

    input.dispatchEvent(new Event("focus"));

    expect(dd.classList.contains("open")).toBe(false);
    expect(dd.textContent).not.toMatch(/no recent searches/i);
  });

  it("непустая история дропдаун по-прежнему открывает", () => {
    State.history = ["Gorillaz"];
    const { input, dd } = makeInputAndDropdown();
    attachGeniusAutocomplete(input, dd, () => {});

    input.dispatchEvent(new Event("focus"));

    expect(dd.classList.contains("open")).toBe(true);
    expect(dd.querySelectorAll(".ac-history").length).toBe(1);
  });
});

describe("[SF-WEB-89] attachGeniusAutocomplete — showHistory:false", () => {
  it("doesn't open the history dropdown on focus when the field has its own chips row for that", () => {
    State.history = ["Gorillaz"];
    const { input, dd } = makeInputAndDropdown();
    attachGeniusAutocomplete(input, dd, () => {}, undefined, { showHistory: false });

    input.dispatchEvent(new Event("focus"));

    expect(dd.classList.contains("open")).toBe(false);
    expect(dd.querySelectorAll(".ac-history").length).toBe(0);
  });

  it("doesn't open the history dropdown when the input is cleared back to empty", () => {
    State.history = ["Gorillaz"];
    const { input, dd } = makeInputAndDropdown();
    attachGeniusAutocomplete(input, dd, () => {}, undefined, { showHistory: false });

    input.value = "";
    input.dispatchEvent(new Event("input"));

    expect(dd.classList.contains("open")).toBe(false);
  });
});

describe("createGeniusAc — remote suggestions", () => {
  let flush;

  beforeEach(() => {
    vi.useFakeTimers();
    flush = () => vi.advanceTimersByTime(300);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function respondWith(payload, { ok = true } = {}) {
    apiFetch.mockResolvedValue({ ok, json: async () => payload });
  }

  const candidate = (over = {}) => ({ id: 7, name: "Drake", image: "", score: 0.9, ...over });

  it("does not even ask the backend for a one-character query", async () => {
    const { dd } = makeInputAndDropdown();
    const ac = createGeniusAc();

    ac("d", dd, vi.fn());
    flush();
    await vi.waitFor(() => expect(apiFetch).not.toHaveBeenCalled());
    expect(dd.classList.contains("open")).toBe(false);
  });

  it("shows a spinner while the request is in flight", () => {
    const { dd } = makeInputAndDropdown();
    apiFetch.mockReturnValue(new Promise(() => {}));

    createGeniusAc()("drake", dd, vi.fn());
    flush();

    expect(dd.querySelector(".ac-spinner")).not.toBeNull();
    expect(dd.classList.contains("open")).toBe(true);
  });

  it("renders one row per candidate, capped at six", async () => {
    const { dd } = makeInputAndDropdown();
    respondWith({
      candidates: Array.from({ length: 10 }, (_, i) => candidate({ id: i, name: `A${i}` })),
    });

    createGeniusAc()("drake", dd, vi.fn());
    flush();

    await vi.waitFor(() => expect(dd.querySelectorAll(".ac-item")).toHaveLength(6));
  });

  it("closes the dropdown when nothing matched", async () => {
    const { dd } = makeInputAndDropdown();
    respondWith({ candidates: [] });

    createGeniusAc()("zzzz", dd, vi.fn());
    flush();

    await vi.waitFor(() => expect(dd.classList.contains("open")).toBe(false));
  });

  it("shows a match percentage only for an imperfect match", async () => {
    const { dd } = makeInputAndDropdown();
    respondWith({
      candidates: [
        candidate({ id: 1, name: "Close", score: 0.42 }),
        candidate({ id: 2, name: "Exact", score: 1 }),
      ],
    });

    createGeniusAc()("drake", dd, vi.fn());
    flush();

    await vi.waitFor(() => expect(dd.querySelectorAll(".ac-item")).toHaveLength(2));
    const hints = dd.querySelectorAll(".ac-hint");
    expect(hints).toHaveLength(1);
    expect(hints[0].textContent).toBe("42%");
  });

  it("passes the picked artist's name, image and id to the caller", async () => {
    const { dd } = makeInputAndDropdown();
    const onSelect = vi.fn();
    respondWith({ candidates: [candidate({ id: 99, name: "Drake", image: "http://img/a.jpg" })] });

    createGeniusAc()("drake", dd, onSelect);
    flush();
    await vi.waitFor(() => expect(dd.querySelector(".ac-item")).not.toBeNull());

    dd.querySelector(".ac-item").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

    expect(onSelect).toHaveBeenCalledWith("Drake", "http://img/a.jpg", 99);
    expect(dd.classList.contains("open")).toBe(false);
  });

  it("reports a null id and image when the backend gave neither", async () => {
    const { dd } = makeInputAndDropdown();
    const onSelect = vi.fn();
    respondWith({ candidates: [{ name: "Nameless" }] });

    createGeniusAc()("name", dd, onSelect);
    flush();
    await vi.waitFor(() => expect(dd.querySelector(".ac-item")).not.toBeNull());

    dd.querySelector(".ac-item").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

    expect(onSelect).toHaveBeenCalledWith("Nameless", null, null);
  });

  it("falls back to a placeholder avatar when the candidate has no image", async () => {
    const { dd } = makeInputAndDropdown();
    respondWith({ candidates: [candidate({ image: "" })] });

    createGeniusAc()("drake", dd, vi.fn());
    flush();
    await vi.waitFor(() => expect(dd.querySelector(".ac-avatar")).not.toBeNull());

    expect(dd.querySelector(".ac-avatar").getAttribute("src")).toBeTruthy();
  });

  it("closes the dropdown instead of rendering when the backend errors", async () => {
    const { dd } = makeInputAndDropdown();
    respondWith(null, { ok: false });

    createGeniusAc()("drake", dd, vi.fn());
    flush();

    await vi.waitFor(() => expect(dd.classList.contains("open")).toBe(false));
  });

  it("closes the dropdown when the request throws outright", async () => {
    const { dd } = makeInputAndDropdown();
    apiFetch.mockRejectedValue(new Error("network down"));

    createGeniusAc()("drake", dd, vi.fn());
    flush();

    await vi.waitFor(() => expect(dd.classList.contains("open")).toBe(false));
  });

  it("leaves the dropdown alone when a request is aborted by a newer keystroke", async () => {
    const { dd } = makeInputAndDropdown();
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    apiFetch.mockRejectedValue(abortErr);

    createGeniusAc()("drake", dd, vi.fn());
    flush();
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalled());

    // Спиннер уже показан и дропдаун открыт — отменённый запрос его не трогает,
    // иначе список мигал бы на каждой букве.
    expect(dd.classList.contains("open")).toBe(true);
  });

  it("aborts the in-flight request when a newer query arrives", async () => {
    const { dd } = makeInputAndDropdown();
    apiFetch.mockReturnValue(new Promise(() => {}));
    const ac = createGeniusAc();

    ac("drak", dd, vi.fn());
    flush();
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    const firstSignal = apiFetch.mock.calls[0][1].signal;

    ac("drake", dd, vi.fn());
    flush();
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));

    expect(firstSignal.aborted).toBe(true);
  });

  it("url-encodes the query so punctuation cannot break the request", async () => {
    const { dd } = makeInputAndDropdown();
    respondWith({ candidates: [] });

    createGeniusAc()("a&b c", dd, vi.fn());
    flush();

    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(apiFetch.mock.calls[0][0]).toBe("/api/v1/search?q=a%26b%20c");
  });
});

describe("attachGeniusAutocomplete — keyboard and blur", () => {
  const key = (el, k) => el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));

  it("closes the dropdown on Escape", () => {
    State.history = ["Gorillaz"];
    const { input, dd } = makeInputAndDropdown();
    attachGeniusAutocomplete(input, dd, () => {});
    input.dispatchEvent(new Event("focus"));
    expect(dd.classList.contains("open")).toBe(true);

    key(input, "Escape");

    expect(dd.classList.contains("open")).toBe(false);
  });

  it("moves focus into the list on ArrowDown", () => {
    State.history = ["Gorillaz", "Drake"];
    const { input, dd } = makeInputAndDropdown();
    attachGeniusAutocomplete(input, dd, () => {});
    input.dispatchEvent(new Event("focus"));

    key(input, "ArrowDown");

    const first = dd.querySelector(".ac-item");
    expect(first.classList.contains("ac-active")).toBe(true);
  });

  it("ignores ArrowDown when the list is empty", () => {
    const { input, dd } = makeInputAndDropdown();
    attachGeniusAutocomplete(input, dd, () => {});

    expect(() => key(input, "ArrowDown")).not.toThrow();
  });

  it("closes the dropdown on Enter so the search can run", () => {
    State.history = ["Gorillaz"];
    const { input, dd } = makeInputAndDropdown();
    attachGeniusAutocomplete(input, dd, () => {});
    input.dispatchEvent(new Event("focus"));

    key(input, "Enter");

    expect(dd.classList.contains("open")).toBe(false);
  });

  it("walks down and back up the list with the arrow keys", () => {
    State.history = ["A", "B", "C"];
    const { input, dd } = makeInputAndDropdown();
    attachGeniusAutocomplete(input, dd, () => {});
    input.dispatchEvent(new Event("focus"));

    const items = [...dd.querySelectorAll(".ac-item")];
    items.forEach((i) => i.setAttribute("tabindex", "-1"));
    items[0].focus();

    key(dd, "ArrowDown");
    expect(document.activeElement).toBe(items[1]);

    key(dd, "ArrowUp");
    expect(document.activeElement).toBe(items[0]);
  });

  it("returns focus to the input when arrowing up off the top of the list", () => {
    State.history = ["A", "B"];
    const { input, dd } = makeInputAndDropdown();
    attachGeniusAutocomplete(input, dd, () => {});
    input.dispatchEvent(new Event("focus"));

    const items = [...dd.querySelectorAll(".ac-item")];
    items.forEach((i) => i.setAttribute("tabindex", "-1"));
    items[0].focus();

    key(dd, "ArrowUp");

    expect(document.activeElement).toBe(input);
  });

  it("picks the focused row on Enter", () => {
    State.history = ["Gorillaz"];
    const onSelect = vi.fn();
    const { input, dd } = makeInputAndDropdown();
    attachGeniusAutocomplete(input, dd, onSelect);
    input.dispatchEvent(new Event("focus"));

    const item = dd.querySelector(".ac-item");
    item.setAttribute("tabindex", "-1");
    item.focus();

    key(dd, "Enter");

    expect(onSelect).toHaveBeenCalledWith("Gorillaz");
  });

  it("closes and returns focus to the input on Escape inside the list", () => {
    State.history = ["Gorillaz"];
    const { input, dd } = makeInputAndDropdown();
    attachGeniusAutocomplete(input, dd, () => {});
    input.dispatchEvent(new Event("focus"));

    const item = dd.querySelector(".ac-item");
    item.setAttribute("tabindex", "-1");
    item.focus();
    // Поле с текстом — обычный случай для списка результатов поиска. С пустым
    // полем поведение другое, см. следующий тест.
    input.value = "drake";

    key(dd, "Escape");

    expect(dd.classList.contains("open")).toBe(false);
    expect(document.activeElement).toBe(input);
  });

  it("re-opens history when Escape returns focus to an empty field", () => {
    // Escape закрывает список и возвращает фокус в поле, а обработчик focus на
    // пустом поле снова показывает историю. Списка результатов на экране не
    // остаётся — но выпадашка остаётся открытой, уже с историей.
    State.history = ["Gorillaz"];
    const { input, dd } = makeInputAndDropdown();
    attachGeniusAutocomplete(input, dd, () => {});
    input.dispatchEvent(new Event("focus"));

    const item = dd.querySelector(".ac-item");
    item.setAttribute("tabindex", "-1");
    item.focus();

    key(dd, "Escape");

    expect(document.activeElement).toBe(input);
    expect(dd.querySelectorAll(".ac-history")).toHaveLength(1);
  });

  it("fills the input and runs the search when a history row is picked", () => {
    State.history = ["Gorillaz"];
    const onSelect = vi.fn();
    const { input, dd } = makeInputAndDropdown();
    attachGeniusAutocomplete(input, dd, onSelect);
    input.dispatchEvent(new Event("focus"));

    dd.querySelector(".ac-history").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

    expect(input.value).toBe("Gorillaz");
    expect(onSelect).toHaveBeenCalledWith("Gorillaz");
    expect(dd.classList.contains("open")).toBe(false);
  });

  it("closes the dropdown shortly after the field loses focus", () => {
    vi.useFakeTimers();
    State.history = ["Gorillaz"];
    const { input, dd } = makeInputAndDropdown();
    attachGeniusAutocomplete(input, dd, () => {});
    input.dispatchEvent(new Event("focus"));

    input.dispatchEvent(new Event("blur"));
    expect(dd.classList.contains("open")).toBe(true);

    vi.advanceTimersByTime(150);
    expect(dd.classList.contains("open")).toBe(false);
    vi.useRealTimers();
  });

  it("shows history again when the field is cleared back to empty", () => {
    State.history = ["Gorillaz"];
    const { input, dd } = makeInputAndDropdown();
    attachGeniusAutocomplete(input, dd, () => {});

    input.value = "";
    input.dispatchEvent(new Event("input"));

    expect(dd.querySelectorAll(".ac-history")).toHaveLength(1);
  });

  it("queries the backend once the field has text", () => {
    const geniusAc = Object.assign(vi.fn(), { cancel: vi.fn() });
    const { input, dd } = makeInputAndDropdown();
    attachGeniusAutocomplete(input, dd, () => {}, geniusAc);

    input.value = "drake";
    input.dispatchEvent(new Event("input"));

    expect(geniusAc).toHaveBeenCalledWith("drake", dd, expect.any(Function));
  });

  it("does not reopen history on focus when the field already has text", () => {
    State.history = ["Gorillaz"];
    const { input, dd } = makeInputAndDropdown();
    attachGeniusAutocomplete(input, dd, () => {});

    input.value = "drake";
    input.dispatchEvent(new Event("focus"));

    expect(dd.classList.contains("open")).toBe(false);
  });
});

describe("attachNodeAutocomplete — search within the rendered graph", () => {
  let flush;

  beforeEach(() => {
    vi.useFakeTimers();
    flush = () => vi.advanceTimersByTime(80);
    State.graphNodes = [
      { id: 1, name: "Drake", isSeed: true },
      { id: 2, name: "Drizzy Drake", imageUrl: "http://img/d.jpg" },
      { id: 3, name: "Future" },
    ];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("lists the graph nodes matching what was typed", () => {
    const { input, dd } = makeInputAndDropdown();
    attachNodeAutocomplete(input, dd, vi.fn());

    input.value = "drake";
    input.dispatchEvent(new Event("input"));
    flush();

    expect(dd.querySelectorAll(".ac-item")).toHaveLength(2);
    expect(dd.classList.contains("open")).toBe(true);
  });

  it("closes the dropdown when the field is empty", () => {
    const { input, dd } = makeInputAndDropdown();
    attachNodeAutocomplete(input, dd, vi.fn());

    input.value = "";
    input.dispatchEvent(new Event("input"));
    flush();

    expect(dd.classList.contains("open")).toBe(false);
  });

  it("selects straight away when exactly one node matches exactly", () => {
    const onSelect = vi.fn();
    const { input, dd } = makeInputAndDropdown();
    attachNodeAutocomplete(input, dd, onSelect);

    input.value = "future";
    input.dispatchEvent(new Event("input"));
    flush();

    expect(onSelect).toHaveBeenCalledWith("Future");
    expect(dd.classList.contains("open")).toBe(false);
  });

  it("fills the input and selects when a row is picked", () => {
    const onSelect = vi.fn();
    const { input, dd } = makeInputAndDropdown();
    attachNodeAutocomplete(input, dd, onSelect);

    input.value = "drake";
    input.dispatchEvent(new Event("input"));
    flush();
    dd.querySelectorAll(".ac-item")[1].dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true }),
    );

    expect(input.value).toBe("Drizzy Drake");
    expect(onSelect).toHaveBeenCalledWith("Drizzy Drake");
  });

  it("uses the node's own image when it has one", () => {
    const { input, dd } = makeInputAndDropdown();
    attachNodeAutocomplete(input, dd, vi.fn());

    input.value = "drizzy";
    input.dispatchEvent(new Event("input"));
    flush();

    expect(dd.querySelector(".ac-avatar").getAttribute("src")).toBe("http://img/d.jpg");
  });

  it("falls back to the Genius search when the graph has no match", async () => {
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({ candidates: [] }) });
    const { input, dd } = makeInputAndDropdown();
    attachNodeAutocomplete(input, dd, vi.fn());

    input.value = "kendrick";
    input.dispatchEvent(new Event("input"));
    flush();
    vi.advanceTimersByTime(300);

    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(apiFetch.mock.calls[0][0]).toContain("kendrick");
  });

  it("closes the dropdown on Escape", () => {
    const { input, dd } = makeInputAndDropdown();
    attachNodeAutocomplete(input, dd, vi.fn());

    input.value = "drake";
    input.dispatchEvent(new Event("input"));
    flush();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(dd.classList.contains("open")).toBe(false);
  });

  it("closes the dropdown shortly after blur", () => {
    const { input, dd } = makeInputAndDropdown();
    attachNodeAutocomplete(input, dd, vi.fn());

    input.value = "drake";
    input.dispatchEvent(new Event("input"));
    flush();
    input.dispatchEvent(new Event("blur"));
    vi.advanceTimersByTime(150);

    expect(dd.classList.contains("open")).toBe(false);
  });
});
