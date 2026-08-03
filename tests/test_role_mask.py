from __future__ import annotations

from dataclasses import dataclass


@dataclass
class RoleMask:
    primary: bool = True
    producer: bool = True
    writer: bool = True
    featured: bool = True


def parse_role_mask(spec: str) -> RoleMask:
    if spec == "":
        return RoleMask()
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

    return mask


def role_allowed(role: str, mask: RoleMask) -> bool:
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
    if role == "featured":
        return "solid"
    if role == "producer":
        return "dashed"
    return "dotted"


def normalize_str(value: str) -> str:
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

    def test_ascii_only_role_spec_still_case_insensitive(self):
        mask = parse_role_mask("PRIMARY,PRODUCER,WRITER,FEATURED")
        assert mask == RoleMask(True, True, True, True)

    def test_non_ascii_token_falls_back_and_is_ignored(self):
        mask = parse_role_mask("продюсер")
        assert mask == RoleMask(False, False, False, False)

    def test_ascii_role_after_non_ascii_token_still_matches(self):
        mask = parse_role_mask("продюсер,producer")
        assert mask.producer is True
        assert mask == RoleMask(False, True, False, False)


class TestToLowerGolden:
    ASCII_CASES = [
        ("primary", (True, False, False, False)),
        ("PRODUCER", (False, True, False, False)),
        ("Writer,Featured", (False, False, True, True)),
        ("PRIMARY,PRODUCER,WRITER,FEATURED", (True, True, True, True)),
        ("", (True, True, True, True)),
    ]

    def test_pure_ascii_specs_match_golden_masks(self):
        for spec, expected in self.ASCII_CASES:
            assert parse_role_mask(spec) == RoleMask(*expected), spec

    def test_ascii_plus_cyrillic_specs_give_identical_results_to_their_ascii_form(self):
        for spec, expected in self.ASCII_CASES:
            if spec == "":
                continue
            spiced = spec + ",продюсер"
            assert parse_role_mask(spiced) == RoleMask(*expected), spiced

    def test_cyrillic_token_interleaved_between_ascii_tokens(self):
        mask = parse_role_mask("primary,продюсер,featured")
        assert mask == RoleMask(True, False, False, True)


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
        mask = RoleMask(True, True, True, True)
        assert role_allowed("composer", mask) is False
        assert role_allowed("", mask) is False

    def test_yandex_feature_typo_is_not_a_recognised_role(self):
        mask = RoleMask(True, True, True, True)
        assert role_allowed("feature", mask) is False


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

    def test_yandex_feature_typo_ranks_as_unknown(self):
        assert role_rank("feature") == 0


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
        assert normalize_str("   Drake") == "drake"

    def test_empty_string(self):
        assert normalize_str("") == ""

    def test_only_whitespace_collapses_to_empty(self):
        assert normalize_str("   \t  ") == ""

    def test_idempotent(self):
        once = normalize_str("  Chris   Martin  ")
        twice = normalize_str(once)
        assert once == twice == "chris martin"
