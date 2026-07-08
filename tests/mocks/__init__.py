"""
mocks/ — test double implementations for six-feat integration tests
===================================================================

This package provides:

  mock_genius_gateway.py
      MockGeniusGateway — a Python-side surrogate that records calls and
      returns canned data.  Used for unit-style tests of algorithms that
      can be invoked without a running userver binary.

  mock_persistent_store.py
      InMemoryStore — SQLite :memory: backed store pre-seeded with test
      data.  Used to verify that the service correctly reads and writes
      L1 without depending on the real Genius network.

Shared builder functions for common test data shapes (e.g. _build_song_detail)
live directly in conftest.py rather than a separate fixtures.py module.

See conftest.py for the integration-test fixtures that wire these mocks
into the running service process, and tests/test_genius_mock_gateway.py for
direct unit coverage of MockGeniusGateway itself.
"""
