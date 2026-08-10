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
  it("renders one item per candidate, reveals the overlay and caps the list at six", () => {
    showCandidatePicker([candidate({ name: "Drake" }), candidate({ id: 2, name: "Drizzy" })], "dr");
    expect(els.candidateList.querySelectorAll(".candidate-item")).toHaveLength(2);
    expect(els.candidateOverlay.classList.contains("show")).toBe(true);

    const many = Array.from({ length: 12 }, (_, i) => candidate({ id: i, name: `Artist ${i}` }));
    showCandidatePicker(many, "artist");
    expect(els.candidateList.querySelectorAll(".candidate-item")).toHaveLength(6);
  });

  it("names the query in the title, and stays readable when there isn't one", () => {
    showCandidatePicker([candidate()], "drake");
    expect(document.querySelector(".candidate-title").textContent).toContain("drake");

    showCandidatePicker([candidate()], "");
    const title = document.querySelector(".candidate-title").textContent;
    expect(title).toBeTruthy();
    expect(title).not.toContain('""');
  });

  it("shows the backend's match percentage, and nothing at all when it scored nothing", () => {
    showCandidatePicker([candidate({ score: 0.87 })], "drake");
    expect(els.candidateList.querySelector(".candidate-score").textContent).toContain("87");

    showCandidatePicker([candidate({ score: null })], "drake");
    expect(els.candidateList.querySelector(".candidate-score")).toBeNull();
  });

  it("uses the candidate's photo when it has one, a generated placeholder when it doesn't", () => {
    showCandidatePicker([candidate({ image: "https://img.example/a.jpg" })], "drake");
    expect(els.candidateList.querySelector(".candidate-avatar").getAttribute("src")).toBe(
      "https://img.example/a.jpg",
    );

    showCandidatePicker([candidate({ image: "" })], "drake");
    const img = els.candidateList.querySelector(".candidate-avatar");
    expect(img.getAttribute("src")).toBeTruthy();
    expect(img.getAttribute("data-fallback")).toBeTruthy();
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
  it("loads the picked artist as an already-disambiguated choice and closes the overlay", () => {
    showCandidatePicker([candidate({ name: "Drake" }), candidate({ id: 2, name: "Drizzy" })], "dr");

    els.candidateList.querySelectorAll(".candidate-item")[1].click();

    expect(searchArtist).toHaveBeenCalledWith("Drizzy", false, true);
    expect(els.candidateOverlay.classList.contains("show")).toBe(false);
  });
});

describe("candidate picker guards", () => {
  it("does nothing when the overlay or the list is not on this page", () => {
    els.candidateOverlay = null;
    expect(() => showCandidatePicker([candidate()], "drake")).not.toThrow();
    expect(() => hideCandidatePicker()).not.toThrow();
    expect(searchArtist).not.toHaveBeenCalled();

    renderMarkup();
    els.candidateList = null;
    expect(() => showCandidatePicker([candidate()], "drake")).not.toThrow();
    expect(els.candidateOverlay.classList.contains("show")).toBe(false);
  });

  it("shows an empty list rather than failing when nothing matched, and hides on request", () => {
    showCandidatePicker([], "nobody");
    expect(els.candidateList.querySelectorAll(".candidate-item")).toHaveLength(0);
    expect(els.candidateOverlay.classList.contains("show")).toBe(true);

    hideCandidatePicker();
    expect(els.candidateOverlay.classList.contains("show")).toBe(false);
  });
});
