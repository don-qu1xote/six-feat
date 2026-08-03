import { els } from "../dom/dom.js";
import { registerDockedPanel, closeOtherDockedPanels } from "./docked-panel.js";
import { showToast } from "./toast.js";
import { escapeHtml, placeholderFor } from "../state/helpers.js";
import { searchArtist } from "../api/api.js";
import {
  fetchSettingsStatus,
  fetchYandexPlaylists,
  fetchYandexImport,
} from "../api/settings-api.js";

let _panel = null;

export function isPlaylistsPanelOpen() {
  return !!els.playlistsPanel?.classList.contains("show");
}

export function closePlaylistsPanel() {
  els.playlistsPanel?.classList.remove("show");
}

function _resetResults() {
  if (els.playlistsArtistSection) els.playlistsArtistSection.hidden = true;
  if (els.playlistsArtistGrid) els.playlistsArtistGrid.innerHTML = "";
  if (els.playlistsTruncatedHint) {
    els.playlistsTruncatedHint.hidden = true;
    els.playlistsTruncatedHint.textContent = "";
  }
}

async function _loadPlaylists() {
  const result = await fetchYandexPlaylists();
  if (!result) {
    showToast("Couldn't load your Yandex playlists — please try again.");
    return;
  }
  _renderPlaylists(result.playlists);
  _resetResults();
}

export async function openPlaylistsPanel() {
  if (!els.playlistsPanel) return;
  closeOtherDockedPanels(_panel);
  els.playlistsPanel.classList.add("show");

  const status = await fetchSettingsStatus();
  const connected = !!status?.yandex?.connected;

  if (els.playlistsConnectHint) els.playlistsConnectHint.hidden = connected;
  if (!connected) {
    if (els.playlistsGrid) {
      els.playlistsGrid.hidden = true;
      els.playlistsGrid.innerHTML = "";
    }
    _resetResults();
    return;
  }

  await _loadPlaylists();
}

function _renderPlaylists(playlists) {
  if (!els.playlistsGrid) return;
  els.playlistsGrid.innerHTML = (playlists || [])
    .map((p) => {
      const label = p.kind === "likes" ? "Liked tracks" : p.title || "Untitled playlist";
      const imgSrc = p.cover_url || placeholderFor(label, false);
      return `<div class="playlist-card bento-tile bento-tile--sm" data-playlist-id="${escapeHtml(String(p.id))}" role="button" tabindex="0">
        <img class="playlist-card-cover" src="${escapeHtml(imgSrc)}"
             data-fallback="${escapeHtml(placeholderFor(label, false))}" alt="" />
        <div class="playlist-card-title">${escapeHtml(label)}</div>
        <div class="playlist-card-count">${p.track_count ?? 0} tracks</div>
      </div>`;
    })
    .join("");
  els.playlistsGrid.hidden = false;

  els.playlistsGrid.querySelectorAll(".playlist-card[data-playlist-id]").forEach((card) => {
    card.addEventListener("click", () => _handlePlaylistPick(card.dataset.playlistId));
  });
}

function _renderImportResults(data) {
  if (!els.playlistsArtistGrid) return;
  const artists = data?.artists || [];
  els.playlistsArtistGrid.innerHTML = artists
    .map((a) => {
      if (!a.resolved) {
        return `<div class="playlist-card playlist-card--unresolved bento-tile bento-tile--sm">
          <div class="playlist-card-title">${escapeHtml(a.yandex_name)}</div>
          <div class="settings-card-sub">Not found on Genius</div>
        </div>`;
      }
      const imgSrc = a.image || placeholderFor(a.name, false);
      return `<div class="playlist-card bento-tile bento-tile--sm" data-artist-name="${escapeHtml(a.name)}" role="button" tabindex="0">
        <img class="playlist-card-cover playlist-card-cover--round" src="${escapeHtml(imgSrc)}"
             data-fallback="${escapeHtml(placeholderFor(a.name, false))}" alt="" />
        <div class="playlist-card-title">${escapeHtml(a.name)}</div>
      </div>`;
    })
    .join("");

  if (els.playlistsTruncatedHint) {
    els.playlistsTruncatedHint.hidden = !data?.truncated;
    if (data?.truncated) {
      els.playlistsTruncatedHint.textContent = `Showing the first ${data.scanned_track_count} of ${data.total_track_count} tracks.`;
    }
  }

  if (els.playlistsArtistSection) els.playlistsArtistSection.hidden = false;
  els.playlistsArtistGrid.querySelectorAll("[data-artist-name]").forEach((card) => {
    card.addEventListener("click", () => _handleArtistPick(card.dataset.artistName));
  });
}

async function _handlePlaylistPick(playlistId) {
  const result = await fetchYandexImport(playlistId);
  if (!result) {
    showToast("Couldn't import that source — please try again.");
    return;
  }
  _renderImportResults(result);
}

function _handleArtistPick(name) {
  if (!name) return;
  closePlaylistsPanel();
  searchArtist(name, false, true);
}

export function setupPlaylistsPanel() {
  if (!els.playlistsPanel) return;

  _panel = registerDockedPanel({
    el: els.playlistsPanel,
    trigger: els.btnPlaylistsOpen,
    isOpen: isPlaylistsPanelOpen,
    close: closePlaylistsPanel,
  });

  els.btnPlaylistsOpen?.addEventListener("click", () => {
    if (isPlaylistsPanelOpen()) closePlaylistsPanel();
    else openPlaylistsPanel();
  });
  els.playlistsPanelClose?.addEventListener("click", closePlaylistsPanel);
}
