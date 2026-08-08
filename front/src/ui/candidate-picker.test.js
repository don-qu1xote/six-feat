import { describe, it, expect, vi, beforeEach } from "vitest";
import { els } from "../dom/dom.js";
import { State } from "../state/state.js";
import { showCandidatePicker, hideCandidatePicker } from "./candidate-picker.js";
import { searchArtist } from "../api/api.js";

vi.mock("../api/api.js", () => ({ searchArtist: vi.fn() }));

function renderMarkup() {
  document.body.innerHTML = `
    <div id="candidate-overlay">
      <h2 class="candidate-title"></h2>
      <div id="candidate-list"></div>
    </div>`;
  els.candidateOverlay = document.getElementById("candidate-overlay");
  els.candidateList = document.getElementById("candidate-list");
}

const candidate = (over = {}) => ({ id: 1, name: "Drake", image: "", score: 0.9, ...over });

beforeEach(() => {
  renderMarkup();
  State.lang = "en";
});

describe("showCandidatePicker rendering", () => {
  it("renders one item per candidate and reveals the overlay", () => {
    showCandidatePicker([candidate({ name: "Drake" }), candidate({ id: 2, name: "Drizzy" })], "dr");

    expect(els.candidateList.querySelectorAll(".candidate-item")).toHaveLength(2);
    expect(els.candidateOverlay.classList.contains("show")).toBe(true);
  });

  it("caps the list at six so the overlay cannot grow unbounded", () => {
    const many = Array.from({ length: 12 }, (_, i) => candidate({ id: i, name: `Artist ${i}` }));
    showCandidatePicker(many, "artist");

    expect(els.candidateList.querySelectorAll(".candidate-item")).toHaveLength(6);
  });

  it("names the query in the title when there is one", () => {
    showCandidatePicker([candidate()], "drake");
    expect(document.querySelector(".candidate-title").textContent).toContain("drake");
  });

  it("falls back to a generic title when the query is empty", () => {
    showCandidatePicker([candidate()], "");
    const title = document.querySelector(".candidate-title").textContent;
    expect(title).toBeTruthy();
    expect(title).not.toContain('""');
  });

  it("shows a match percentage when the backend scored the candidate", () => {
    showCandidatePicker([candidate({ score: 0.87 })], "drake");
    expect(els.candidateList.querySelector(".candidate-score").textContent).toContain("87");
  });

  it("omits the score line entirely when the backend gave no score", () => {
    showCandidatePicker([candidate({ score: null })], "drake");
    expect(els.candidateList.querySelector(".candidate-score")).toBeNull();
  });

  it("uses a generated placeholder avatar when the candidate has no image", () => {
    showCandidatePicker([candidate({ image: "" })], "drake");
    const img = els.candidateList.querySelector(".candidate-avatar");
    expect(img.getAttribute("src")).toBeTruthy();
    expect(img.getAttribute("data-fallback")).toBeTruthy();
  });

  it("keeps the candidate's own image when it has one", () => {
    showCandidatePicker([candidate({ image: "https://img.example/a.jpg" })], "drake");
    expect(els.candidateList.querySelector(".candidate-avatar").getAttribute("src")).toBe(
      "https://img.example/a.jpg",
    );
  });

  it("escapes markup in artist names instead of injecting it", () => {
    showCandidatePicker([candidate({ name: '<img src=x onerror="boom">' })], "x");

    expect(els.candidateList.querySelector("img[onerror]")).toBeNull();
    expect(els.candidateList.querySelector(".candidate-name").textContent).toBe(
      '<img src=x onerror="boom">',
    );
  });
});

describe("showCandidatePicker selection", () => {
  it("loads the picked artist as an explicit, already-disambiguated choice", () => {
    showCandidatePicker([candidate({ name: "Drake" }), candidate({ id: 2, name: "Drizzy" })], "dr");

    els.candidateList.querySelectorAll(".candidate-item")[1].click();

    expect(searchArtist).toHaveBeenCalledWith("Drizzy", false, true);
  });

  it("closes the overlay on pick so the graph is not rendered behind it", () => {
    showCandidatePicker([candidate()], "drake");
    els.candidateList.querySelector(".candidate-item").click();

    expect(els.candidateOverlay.classList.contains("show")).toBe(false);
  });
});

describe("candidate picker guards", () => {
  it("does nothing when the overlay is not on this page", () => {
    els.candidateOverlay = null;
    expect(() => showCandidatePicker([candidate()], "drake")).not.toThrow();
    expect(searchArtist).not.toHaveBeenCalled();
  });

  it("does nothing when the list container is missing", () => {
    els.candidateList = null;
    expect(() => showCandidatePicker([candidate()], "drake")).not.toThrow();
    expect(els.candidateOverlay.classList.contains("show")).toBe(false);
  });

  it("renders an empty list rather than failing when there are no candidates", () => {
    showCandidatePicker([], "nobody");

    expect(els.candidateList.querySelectorAll(".candidate-item")).toHaveLength(0);
    expect(els.candidateOverlay.classList.contains("show")).toBe(true);
  });
});

describe("hideCandidatePicker", () => {
  it("hides a shown overlay", () => {
    showCandidatePicker([candidate()], "drake");
    hideCandidatePicker();
    expect(els.candidateOverlay.classList.contains("show")).toBe(false);
  });

  it("is safe to call when the overlay is not on this page", () => {
    els.candidateOverlay = null;
    expect(() => hideCandidatePicker()).not.toThrow();
  });
});
