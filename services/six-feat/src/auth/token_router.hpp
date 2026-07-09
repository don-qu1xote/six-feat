#pragma once
// ════════════════════════════════════════════════════════════════════════════
// token_router.hpp
//
// ExtractToken — вспомогательная функция для API-хэндлеров.
// Возвращает токен пользователя из сессионной cookie если валидна,
// иначе пустую строку. [ТЗ-6] Пустая строка больше не означает "используй
// серверный fallback" — такого fallback'а больше нет. Хэндлеры обязаны
// сами отклонить запрос с 401, если ExtractToken вернул пустую строку.
//
// RequireSession — единая точка входа для проверки сессии (IDEA-1).
// Оборачивает ExtractToken и, в отличие от него, сама выставляет 401 при
// отсутствии/невалидности токена, чтобы эта проверка не копипастилась по
// каждому хэндлеру (что уже приводило к пропущенной проверке в новых
// хендлерах). Тело ответа при 401 у хэндлеров разное (graph/path/search
// отдают JSON своего формата, status/sse — плоский {"error":...}), поэтому
// RequireSession не пишет тело: она лишь сигнализирует вызывающему коду
// (через std::nullopt), что нужно немедленно вернуть свой error-body и
// прекратить обработку запроса.
//
// Header-only — нет .cpp файла, нет компонента.
// ════════════════════════════════════════════════════════════════════════════

#include "auth/oauth_handler.hpp"
#include "session_crypto.hpp"

#include <array>
#include <optional>
#include <string>

#include <userver/logging/log.hpp>
#include <userver/server/http/http_request.hpp>
#include <userver/server/http/http_response.hpp>
#include <userver/server/http/http_status.hpp>

namespace six_feat::auth {

inline std::string ExtractToken(
    const userver::server::http::HttpRequest& request,
    const std::array<unsigned char, 32>&      session_key)
{
    const std::string cookie = request.GetCookie("six_feat_session");
    if (cookie.empty()) return "";

    const auto session = Decrypt(cookie, session_key);
    if (!session) {
        LOG_DEBUG() << "[TokenRouter] Invalid or expired session cookie";
        return "";
    }

    return session->access_token;
}

inline std::optional<std::string> RequireSession(
    const userver::server::http::HttpRequest& request,
    const OAuthConfig&                        oauth)
{
    std::string token = ExtractToken(request, oauth.SessionKey());
    if (token.empty()) {
        request.GetHttpResponse().SetStatus(
            userver::server::http::HttpStatus::kUnauthorized);
        return std::nullopt;
    }
    return token;
}

} // namespace six_feat::auth
