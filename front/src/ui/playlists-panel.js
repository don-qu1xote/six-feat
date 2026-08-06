import { els } from "../dom/dom.js";
import { showToast } from "./toast.js";
import { escapeHtml, placeholderFor } from "../state/helpers.js";
import { searchArtist } from "../api/api.js";
import {
  fetchSettingsStatus,
  fetchYandexPlaylists,
  fetchYandexImport,
  startYandexDeviceFlow,
  pollYandexDeviceFlow,
} from "../api/settings-api.js";
import { t, tPlural } from "../i18n/i18n.js";

let _devicePollTimer = null;

function _stopDevicePolling() {
  if (_devicePollTimer) {
    clearTimeout(_devicePollTimer);
    _devicePollTimer = null;
  }
}

function _resetResults() {
  if (els.playlistsArtistSection) els.playlistsArtistSection.hidden = true;
  if (els.playlistsArtistGrid) els.playlistsArtistGrid.innerHTML = "";
  if (els.playlistsTruncatedHint) {
    els.playlistsTruncatedHint.hidden = true;
    els.playlistsTruncatedHint.textContent = "";
  }
}

function _hideGrantHint() {
  if (els.playlistsGrantHint) els.playlistsGrantHint.hidden = true;
  if (els.playlistsDeviceCode) {
    els.playlistsDeviceCode.hidden = true;
    els.playlistsDeviceCode.textContent = "";
  }
}

async function _loadPlaylists() {
  const { status, data } = await fetchYandexPlaylists();
  if (status === 404 || status === 502) {
    if (els.playlistsGrantHint) els.playlistsGrantHint.hidden = false;
    if (els.playlistsGrid) {
      els.playlistsGrid.hidden = true;
      els.playlistsGrid.innerHTML = "";
    }
    return;
  }
  if (!data) {
    showToast(t("playlists.loadError"));
    return;
  }
  _hideGrantHint();
  _renderPlaylists(data.playlists);
  _resetResults();
}

async function _pollDeviceFlowOnce(deviceCode, intervalMs) {
  const result = await pollYandexDeviceFlow(deviceCode);
  const pollStatus = result.data?.status;

  if (pollStatus === "connected") {
    showToast(t("playlists.grantConnectedToast"));
    _hideGrantHint();
    await _loadPlaylists();
    return;
  }
  if (pollStatus === "denied") {
    showToast(t("playlists.grantDeniedToast"));
    _hideGrantHint();
    return;
  }
  if (pollStatus === "expired") {
    showToast(t("playlists.grantExpiredToast"));
    _hideGrantHint();
    return;
  }

  _devicePollTimer = setTimeout(() => _pollDeviceFlowOnce(deviceCode, intervalMs), intervalMs);
}

function _copyDeviceCode(code) {
  const write = navigator.clipboard?.writeText?.(code);
  if (!write || typeof write.then !== "function") {
    showToast(t("toast.copyFallback", { link: code }), 6000);
    return;
  }
  write
    .then(() => showToast(t("playlists.grantCodeCopiedToast"), 2000))
    .catch(() => showToast(t("toast.copyFallback", { link: code }), 6000));
}

async function _handleGrantAccess() {
  const result = await startYandexDeviceFlow();
  if (!result.ok || !result.data?.device_code) {
    showToast(t("playlists.grantUnreachableToast"));
    return;
  }

  const {
    device_code: deviceCode,
    user_code: userCode,
    verification_url: verificationUrl,
    interval,
  } = result.data;
  const intervalMs = Math.max(1, interval || 5) * 1000;

  if (els.playlistsDeviceCode) {
    els.playlistsDeviceCode.hidden = false;
    els.playlistsDeviceCode.innerHTML = `
      <span class="playlists-device-instructions">${escapeHtml(t("playlists.grantInstructions"))}</span>
      <span class="playlists-device-code-row">
        <code class="playlists-device-code-value">${escapeHtml(userCode)}</code>
        <button type="button" class="ui-btn ui-btn--ghost playlists-device-copy-btn">${escapeHtml(t("playlists.grantCopyCode"))}</button>
      </span>
      <a class="ui-btn ui-btn--primary" href="${escapeHtml(verificationUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t("playlists.grantOpenYandex"))}</a>
    `;
    els.playlistsDeviceCode
      .querySelector(".playlists-device-copy-btn")
      ?.addEventListener("click", () => _copyDeviceCode(userCode));
  }

  _stopDevicePolling();
  _devicePollTimer = setTimeout(() => _pollDeviceFlowOnce(deviceCode, intervalMs), intervalMs);
}

export async function activatePlaylistsTab() {
  const { data } = await fetchSettingsStatus();
  const connected = !!data?.yandex?.connected;

  if (els.playlistsConnectHint) els.playlistsConnectHint.hidden = connected;
  if (!connected) {
    _hideGrantHint();
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
      const label =
        p.kind === "likes" ? t("playlists.likedTracks") : p.title || t("playlists.untitled");
      const imgSrc = p.cover_url || placeholderFor(label, false);
      return `<div class="playlist-card bento-tile bento-tile--sm" data-playlist-id="${escapeHtml(String(p.id))}" role="button" tabindex="0">
        <img class="playlist-card-cover" src="${escapeHtml(imgSrc)}"
             data-fallback="${escapeHtml(placeholderFor(label, false))}" alt="" />
        <div class="playlist-card-title">${escapeHtml(label)}</div>
        <div class="playlist-card-count">${escapeHtml(tPlural("playlists.trackCount", p.track_count ?? 0))}</div>
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
          <div class="settings-card-sub">${escapeHtml(t("playlists.notFoundOnGenius"))}</div>
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
      els.playlistsTruncatedHint.textContent = t("playlists.truncatedHint", {
        scanned: data.scanned_track_count,
        total: data.total_track_count,
      });
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
    showToast(t("playlists.importError"));
    return;
  }
  _renderImportResults(result);
}

function _handleArtistPick(name) {
  if (!name) return;
  searchArtist(name, false, true);
}

export function setupPlaylistsPanel() {
  els.playlistsGrantBtn?.addEventListener("click", _handleGrantAccess);
}
