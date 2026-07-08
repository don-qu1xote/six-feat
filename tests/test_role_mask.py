"""
test_role_mask.py — unit tests for src/domain/role_mask.cpp logic
=============================================================

role_mask.cpp has no I/O and no userver dependencies — every function is a
pure transformation of strings/structs. This file is a faithful Python
re-implementation of that logic (mirroring the C++ source line-for-line)
so the contract has direct unit-test coverage without needing the compiled
binary or going through an HTTP round-trip via test_graph.py/test_path.py's
?roles= query param (which only exercises a handful of role combinations
indirectly).

Functions covered (mirrored 1:1 from role_mask.cpp):
  ParseRoleMask    — "primary,producer,featured" → mask dict
  RoleAllowed      — single-role membership check against a mask
  RoleRank         — numeric dominance: producer(4) > writer(3) > featured(2) > primary(1)
  EdgeStyleForRole — frontend CSS hint
  NormalizeStr     — lower-case + collapse whitespace + trim
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class RoleMask:
    primary: bool = True
    producer: bool = True
    writer: bool = True
    featured: bool = True


def parse_role_mask(spec: str) -> RoleMask:
    """Mirror of ParseRoleMask(const std::string& spec)."""
    if spec == "":
        return RoleMask()  # all roles enabled by default
    mask = RoleMask(primary=False, producer=False, writer=False, featured=False)
    for tok in spec.split(","):
        tok = tok.lower()
        if tok == "primary":
            mask.primary = True
        elif tok == "producer":
            mask.producer = True
        elif tok == "writer":
            mask.writer = True
        elif tok == "featured":
            mask.featured = True
        # unrecognised tokens are silently ignored, matching the C++ if/elif chain
    return mask


def role_allowed(role: str, mask: RoleMask) -> bool:
    """Mirror of RoleAllowed(const std::string& role, const RoleMask& mask)."""
    if role == "featured":
        return mask.featured
    if role == "producer":
        return mask.producer
    if role == "writer":
        return mask.writer
    if role == "primary":
        return mask.primary
    return False


def role_rank(role: str) -> int:
    """Mirror of RoleRank(std::string_view role)."""
    if role == "producer":
        return 4
    if role == "writer":
        return 3
    if role == "featured":
        return 2
    if role == "primary":
        return 1
    return 0


def edge_style_for_role(role: str) -> str:
    """Mirror of EdgeStyleForRole(std::string_view role)."""
    if role == "featured":
        return "solid"
    if role == "producer":
        return "dashed"
    return "dotted"


def normalize_str(value: str) -> str:
    """Mirror of NormalizeStr(std::string_view value)."""
    out_chars: list[str] = []
    prev_space = False
    for c in value:
        if c.isspace():
            if out_chars and not prev_space:
                out_chars.append(" ")
            prev_space = True
        else:
            out_chars.append(c.lower())
            prev_space = False
    out = "".join(out_chars)
    return out.rstrip(" ")


# ─────────────────────────────────────────────────────────────────────────────
# ParseRoleMask
# ─────────────────────────────────────────────────────────────────────────────

class TestParseRoleMask:
    def test_empty_spec_enables_all_roles(self):
        mask = parse_role_mask("")
        assert mask == RoleMask(True, True, True, True)

    def test_single_role(self):
        mask = parse_role_mask("producer")
        assert mask.producer is True
        assert mask.primary is False
        assert mask.writer is False
        assert mask.featured is False

    def test_multiple_roles_comma_separated(self):
        mask = parse_role_mask("primary,featured")
        assert mask.primary is True
        assert mask.featured is True
        assert mask.producer is False
        assert mask.writer is False

    def test_all_four_roles(self):
        mask = parse_role_mask("primary,producer,writer,featured")
        assert mask == RoleMask(True, True, True, True)

    def test_case_insensitive(self):
        mask = parse_role_mask("PRODUCER,Featured")
        assert mask.producer is True
        assert mask.featured is True

    def test_unknown_token_is_ignored(self):
        """An unrecognised role token contributes nothing — it's not an
        error and doesn't enable anything (mirrors the C++ if/elif chain
        having no else branch)."""
        mask = parse_role_mask("bogus")
        assert mask == RoleMask(False, False, False, False)

    def test_trailing_comma_does_not_crash(self):
        mask = parse_role_mask("primary,")
        assert mask.primary is True
        assert mask.producer is False

    def test_leading_comma_does_not_crash(self):
        mask = parse_role_mask(",primary")
        assert mask.primary is True

    def test_duplicate_roles_idempotent(self):
        mask = parse_role_mask("primary,primary,primary")
        assert mask.primary is True
        assert mask.producer is False


# ─────────────────────────────────────────────────────────────────────────────
# RoleAllowed
# ─────────────────────────────────────────────────────────────────────────────

class TestRoleAllowed:
    def test_default_mask_allows_all_known_roles(self):
        mask = RoleMask()
        for role in ("primary", "producer", "writer", "featured"):
            assert role_allowed(role, mask) is True

    def test_restricted_mask_blocks_disabled_roles(self):
        mask = RoleMask(primary=True, producer=False, writer=False, featured=False)
        assert role_allowed("primary", mask) is True
        assert role_allowed("producer", mask) is False
        assert role_allowed("writer", mask) is False
        assert role_allowed("featured", mask) is False

    def test_unknown_role_string_is_never_allowed(self):
        """An unrecognised role always returns False, even against a mask
        that enables everything else — mirrors the final `return false`."""
        mask = RoleMask(True, True, True, True)
        assert role_allowed("composer", mask) is False
        assert role_allowed("", mask) is False


# ─────────────────────────────────────────────────────────────────────────────
# RoleRank
# ─────────────────────────────────────────────────────────────────────────────

class TestRoleRank:
    def test_dominance_ordering(self):
        assert role_rank("producer") > role_rank("writer")
        assert role_rank("writer") > role_rank("featured")
        assert role_rank("featured") > role_rank("primary")

    def test_exact_values(self):
        assert role_rank("producer") == 4
        assert role_rank("writer") == 3
        assert role_rank("featured") == 2
        assert role_rank("primary") == 1

    def test_unknown_role_rank_zero(self):
        assert role_rank("unknown") == 0
        assert role_rank("") == 0


# ─────────────────────────────────────────────────────────────────────────────
# EdgeStyleForRole
# ─────────────────────────────────────────────────────────────────────────────

class TestEdgeStyleForRole:
    def test_featured_is_solid(self):
        assert edge_style_for_role("featured") == "solid"

    def test_producer_is_dashed(self):
        assert edge_style_for_role("producer") == "dashed"

    def test_primary_falls_back_to_dotted(self):
        assert edge_style_for_role("primary") == "dotted"

    def test_writer_falls_back_to_dotted(self):
        assert edge_style_for_role("writer") == "dotted"

    def test_unknown_falls_back_to_dotted(self):
        assert edge_style_for_role("anything-else") == "dotted"


# ─────────────────────────────────────────────────────────────────────────────
# NormalizeStr
# ─────────────────────────────────────────────────────────────────────────────

class TestNormalizeStr:
    def test_lowercases(self):
        assert normalize_str("DRAKE") == "drake"

    def test_collapses_interior_whitespace(self):
        assert normalize_str("Chris   Martin") == "chris martin"

    def test_collapses_tabs_and_mixed_whitespace(self):
        assert normalize_str("Chris\t\nMartin") == "chris martin"

    def test_trims_trailing_whitespace(self):
        assert normalize_str("Drake   ") == "drake"

    def test_trims_leading_whitespace_via_collapse(self):
        """Leading whitespace before any non-space char is swallowed because
        `out.empty()` is checked before pushing a collapsed space."""
        assert normalize_str("   Drake") == "drake"

    def test_empty_string(self):
        assert normalize_str("") == ""

    def test_only_whitespace_collapses_to_empty(self):
        assert normalize_str("   \t  ") == ""

    def test_idempotent(self):
        once = normalize_str("  Chris   Martin  ")
        twice = normalize_str(once)
        assert once == twice == "chris martin"
