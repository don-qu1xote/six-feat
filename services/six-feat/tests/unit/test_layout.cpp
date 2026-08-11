#include <algorithm>
#include <cmath>
#include <gtest/gtest.h>
#include <six-feat-layout/layout.hpp>
#include <string>
#include <vector>

namespace {

using six_feat::layout::LayoutParams;
using six_feat::layout::LayoutRequest;
using six_feat::layout::Point;

struct Expected {
  std::int64_t id;
  double x;
  double y;
};

LayoutRequest MakeRequest(std::int64_t seed,
                          std::vector<std::int64_t> nodes,
                          std::vector<std::pair<std::int64_t, std::int64_t>> edges,
                          std::vector<std::int64_t> expanded) {
  LayoutRequest r;
  r.seed_id = seed;
  r.nodes = std::move(nodes);
  r.edges = std::move(edges);
  r.expanded = std::move(expanded);
  return r;
}

std::vector<std::int64_t> Range(std::int64_t from, std::int64_t to) {
  std::vector<std::int64_t> v;
  for (std::int64_t i = from; i < to; ++i) v.push_back(i);
  return v;
}

void Fan(std::vector<std::pair<std::int64_t, std::int64_t>>& edges,
         std::int64_t hub,
         std::int64_t from,
         std::int64_t to) {
  for (std::int64_t i = from; i < to; ++i) edges.emplace_back(hub, i);
}

void ExpectMatchesJs(const six_feat::layout::LayoutResult& result,
                     const std::vector<Expected>& expected) {
  ASSERT_EQ(result.order.size(), expected.size());
  for (std::size_t i = 0; i < expected.size(); ++i) {
    SCOPED_TRACE("index " + std::to_string(i) + ", id " + std::to_string(expected[i].id));

    EXPECT_EQ(result.order[i], expected[i].id);
    const auto it = result.positions.find(expected[i].id);
    ASSERT_NE(it, result.positions.end());
    EXPECT_NEAR(it->second.x, expected[i].x, 1e-6);
    EXPECT_NEAR(it->second.y, expected[i].y, 1e-6);
  }
}

double MinPairDistance(const six_feat::layout::LayoutResult& result) {
  double worst = std::numeric_limits<double>::infinity();
  for (std::size_t i = 0; i < result.order.size(); ++i) {
    for (std::size_t j = i + 1; j < result.order.size(); ++j) {
      const auto& a = result.positions.at(result.order[i]);
      const auto& b = result.positions.at(result.order[j]);
      worst = std::min(worst, std::hypot(a.x - b.x, a.y - b.y));
    }
  }
  return worst;
}

TEST(LayoutJsParity, SeedWithFourLeaves) {
  const auto r = six_feat::layout::PlaceExpandedNodes(
      MakeRequest(1, {1, 2, 3, 4, 5}, {{1, 2}, {1, 3}, {1, 4}, {1, 5}}, {1}));
  ExpectMatchesJs(r, {{2, 150.0, 0.0}, {3, 0.0, 150.0}, {4, -150.0, 0.0}, {5, 0.0, -150.0}});
}

TEST(LayoutJsParity, OnePoleWithLeaves) {
  std::vector<std::pair<std::int64_t, std::int64_t>> edges;
  Fan(edges, 1, 2, 8);
  Fan(edges, 2, 8, 15);
  const auto r = six_feat::layout::PlaceExpandedNodes(MakeRequest(1, Range(1, 15), edges, {1, 2}));
  ExpectMatchesJs(r,
                  {{2, 46.6853369990, -531.9553358220},
                   {8, 59.7991957060, -681.3809919520},
                   {9, 171.6873764170, -614.8678809610},
                   {10, 189.4464718680, -485.9199323720},
                   {11, 99.7035209670, -391.6375815330},
                   {12, -29.9632038360, -403.0173616330},
                   {13, -101.9120140450, -511.4900661530},
                   {14, -61.9639880850, -635.3735361490},
                   {3, 150.0000000000, 0.0000000000},
                   {4, 46.3525491560, 142.6584774440},
                   {5, -121.3525491560, 88.1677878440},
                   {6, -121.3525491560, -88.1677878440},
                   {7, 46.3525491560, -142.6584774440}});
}

TEST(LayoutJsParity, TwoPolesSharingLeavesGetAnEulerZone) {
  std::vector<std::pair<std::int64_t, std::int64_t>> edges;
  Fan(edges, 1, 2, 6);
  Fan(edges, 2, 6, 14);
  Fan(edges, 3, 10, 20);
  const auto r =
      six_feat::layout::PlaceExpandedNodes(MakeRequest(1, Range(1, 20), edges, {1, 2, 3}));
  ExpectMatchesJs(r,
                  {{2, 54.8683848320, -625.1969452470},
                   {3, 381.8562291500, 498.0638315110},
                   {6, 67.9822435400, -774.6226013760},
                   {7, 204.2940409620, -612.0830865390},
                   {8, 41.7545261250, -475.7712891170},
                   {9, -94.5572712970, -638.3108039540},
                   {14, 473.1220582970, 617.1039442040},
                   {15, 324.3973820620, 636.6224143960},
                   {16, 233.1315529150, 517.5823017020},
                   {17, 290.5904000040, 379.0237188170},
                   {18, 439.3150762390, 359.5052486250},
                   {19, 530.5809053860, 478.5453613190},
                   {10, 344.1933745810, -87.7082803030},
                   {11, 260.9493665130, -89.7765031790},
                   {12, 252.2329475720, -11.0660948060},
                   {13, 390.4412719400, -169.3750568790},
                   {4, 107.3565377170, 7.0928139550},
                   {5, -150.0000000000, 0.0000000000}});
}

TEST(LayoutJsParity, NestedPolesFollowTheExpandChain) {
  std::vector<std::pair<std::int64_t, std::int64_t>> edges;
  Fan(edges, 1, 2, 6);
  Fan(edges, 2, 6, 12);
  Fan(edges, 6, 12, 19);
  Fan(edges, 12, 19, 26);
  auto req = MakeRequest(1, Range(1, 26), edges, {1, 2, 6, 12});
  req.expand_parent = {{2, 1}, {6, 2}, {12, 6}};
  const auto r = six_feat::layout::PlaceExpandedNodes(req);
  ExpectMatchesJs(r,
                  {{2, 46.6853369990, -531.9553358220},    {6, 93.3706739980, -1063.9106716440},
                   {12, 140.0560109970, -1595.8660074650}, {7, 59.7991957060, -681.3809919520},
                   {8, 192.8499861650, -565.6583821840},   {9, 123.9061994300, -403.3593078680},
                   {10, -51.7541945450, -418.7755733660},  {11, -91.3745017630, -590.6024237390},
                   {13, 106.4845327050, -1213.3363277730}, {14, 229.3340175370, -1127.2665649260},
                   {15, 216.2201588290, -977.8409087960},  {16, 80.2568152900, -914.4850155140},
                   {17, -42.5926695420, -1000.5547783610}, {18, -29.4788108340, -1149.9804344910},
                   {19, 153.1698697040, -1745.2916635950}, {20, 265.0580504140, -1678.7785526040},
                   {21, 282.8171458660, -1549.8306040160}, {22, 193.0741949650, -1455.5482531760},
                   {23, 63.4074701610, -1466.9280332770},  {24, -8.5413400480, -1575.4007377970},
                   {25, 31.4066859130, -1699.2842077930},  {3, 150.0000000000, 0.0000000000},
                   {4, -75.0000000000, 129.9038105680},    {5, -75.0000000000, -129.9038105680}});
}

TEST(LayoutJsParity, PinnedPolesKeepTheirSpot) {
  std::vector<std::pair<std::int64_t, std::int64_t>> edges;
  Fan(edges, 1, 2, 6);
  Fan(edges, 2, 6, 13);
  Fan(edges, 3, 13, 20);
  auto req = MakeRequest(1, Range(1, 20), edges, {1, 2, 3});
  req.pinned = {{2, {420.0, -130.0}}, {3, {-310.0, 260.0}}};
  const auto r = six_feat::layout::PlaceExpandedNodes(req);
  ExpectMatchesJs(r,
                  {{2, 420.0000000000, -130.0000000000},
                   {3, -310.0000000000, 260.0000000000},
                   {6, 563.2928836040, -174.3525592110},
                   {7, 544.0178787250, -45.6224807390},
                   {8, 431.3548816620, 19.5696047410},
                   {9, 310.1414271110, -27.8672728120},
                   {10, 271.6537186510, -152.2121770660},
                   {11, 344.8737857600, -259.8308589430},
                   {12, 474.6654244870, -269.6842559690},
                   {13, -424.9287314690, 356.3918392960},
                   {14, -457.0190666260, 230.2444282810},
                   {15, -378.4010459720, 126.5035696730},
                   {16, -248.2756425730, 123.2882459320},
                   {17, -164.6299392650, 223.0196614160},
                   {18, -190.4508566980, 350.5980261150},
                   {19, -306.2947173960, 409.9542292860},
                   {4, 150.0000000000, 0.0000000000},
                   {5, -150.0000000000, 0.0000000000}});
}

TEST(LayoutInvariants, NoTwoNodesEndUpCloserThanMinSep) {
  std::vector<std::pair<std::int64_t, std::int64_t>> edges;
  Fan(edges, 1, 2, 8);
  Fan(edges, 2, 8, 30);
  Fan(edges, 3, 25, 50);
  auto req = MakeRequest(1, Range(1, 50), edges, {1, 2, 3});
  const auto r = six_feat::layout::PlaceExpandedNodes(req);
  ASSERT_GE(r.order.size(), 40u);
  EXPECT_GE(MinPairDistance(r), req.params.MinSep() - 1e-9);
}

TEST(LayoutInvariants, MinSepFollowsTheNodeSizeFromTheRequest) {
  std::vector<std::pair<std::int64_t, std::int64_t>> edges;
  Fan(edges, 1, 2, 6);
  Fan(edges, 2, 6, 18);
  const auto nodes = Range(1, 18);

  const auto small = six_feat::layout::PlaceExpandedNodes(MakeRequest(1, nodes, edges, {1, 2}));
  EXPECT_GE(MinPairDistance(small), LayoutParams{}.MinSep() - 1e-9);

  auto req = MakeRequest(1, nodes, edges, {1, 2});
  req.params.node_radius = 40.0;
  req.params.node_gap = 90.0;
  ASSERT_DOUBLE_EQ(req.params.MinSep(), 170.0);
  const auto big = six_feat::layout::PlaceExpandedNodes(req);
  EXPECT_GE(MinPairDistance(big), 170.0 - 1e-9);
  EXPECT_GT(MinPairDistance(big), MinPairDistance(small));
}

TEST(LayoutInvariants, PinnedNodesDoNotMoveEvenWhenCrowded) {
  std::vector<std::pair<std::int64_t, std::int64_t>> edges;
  Fan(edges, 1, 2, 6);
  Fan(edges, 2, 6, 25);
  Fan(edges, 3, 25, 45);
  auto req = MakeRequest(1, Range(1, 45), edges, {1, 2, 3});
  req.pinned = {{2, {30.0, 0.0}}, {3, {-30.0, 0.0}}};
  const auto r = six_feat::layout::PlaceExpandedNodes(req);
  EXPECT_DOUBLE_EQ(r.positions.at(2).x, 30.0);
  EXPECT_DOUBLE_EQ(r.positions.at(2).y, 0.0);
  EXPECT_DOUBLE_EQ(r.positions.at(3).x, -30.0);
  EXPECT_DOUBLE_EQ(r.positions.at(3).y, 0.0);
}

TEST(LayoutInvariants, TheSameRequestGivesTheSameAnswer) {
  std::vector<std::pair<std::int64_t, std::int64_t>> edges;
  Fan(edges, 1, 2, 6);
  Fan(edges, 2, 6, 20);
  Fan(edges, 3, 15, 35);
  auto req = MakeRequest(1, Range(1, 35), edges, {1, 2, 3});
  const auto a = six_feat::layout::PlaceExpandedNodes(req);
  const auto b = six_feat::layout::PlaceExpandedNodes(req);
  ASSERT_EQ(a.order, b.order);
  for (const auto id : a.order) {
    EXPECT_DOUBLE_EQ(a.positions.at(id).x, b.positions.at(id).x);
    EXPECT_DOUBLE_EQ(a.positions.at(id).y, b.positions.at(id).y);
  }
}

TEST(LayoutInvariants, LayingOutAnAlreadyLaidOutGraphChangesNothing) {
  std::vector<std::pair<std::int64_t, std::int64_t>> edges;
  Fan(edges, 1, 2, 6);
  Fan(edges, 2, 6, 20);
  auto req = MakeRequest(1, Range(1, 20), edges, {1, 2});
  const auto first = six_feat::layout::PlaceExpandedNodes(req);
  for (const auto id : first.order) req.pinned[id] = first.positions.at(id);
  const auto second = six_feat::layout::PlaceExpandedNodes(req);
  for (const auto id : first.order) {
    EXPECT_NEAR(second.positions.at(id).x, first.positions.at(id).x, 1e-9);
    EXPECT_NEAR(second.positions.at(id).y, first.positions.at(id).y, 1e-9);
  }
}

TEST(LayoutInvariants, ACycleInTheExpandChainFallsBackToTheSeed) {
  std::vector<std::pair<std::int64_t, std::int64_t>> edges{{1, 2}, {2, 3}, {3, 4}};
  Fan(edges, 2, 5, 10);
  Fan(edges, 3, 10, 16);
  auto req = MakeRequest(1, Range(1, 16), edges, {1, 2, 3, 4});
  req.expand_parent = {{2, 3}, {3, 4}, {4, 2}};
  const auto r = six_feat::layout::PlaceExpandedNodes(req);
  EXPECT_EQ(r.order.size(), 14u);
  EXPECT_GE(MinPairDistance(r), req.params.MinSep() - 1e-9);
}

TEST(LayoutInvariants, AnUnknownPinnedIdIsIgnored) {
  std::vector<std::pair<std::int64_t, std::int64_t>> edges;
  Fan(edges, 1, 2, 8);
  Fan(edges, 2, 8, 20);
  auto req = MakeRequest(1, Range(1, 20), edges, {1, 2});
  const auto clean = six_feat::layout::PlaceExpandedNodes(req);
  req.pinned = {{999999, {12345.0, -9999.0}}};
  const auto dirty = six_feat::layout::PlaceExpandedNodes(req);
  EXPECT_EQ(dirty.order, clean.order);
  EXPECT_EQ(dirty.positions.find(999999), dirty.positions.end());
}

TEST(LayoutInvariants, ASeedWithNoNeighboursPlacesNothing) {
  const auto r = six_feat::layout::PlaceExpandedNodes(MakeRequest(1, {1}, {}, {1}));
  EXPECT_TRUE(r.order.empty());
  EXPECT_TRUE(r.positions.empty());
}

TEST(LayoutInvariants, EdgesToNodesOutsideTheNodeListDoNotCrash) {
  std::vector<std::pair<std::int64_t, std::int64_t>> edges{{1, 2}, {2, 777}, {888, 999}, {2, 2}};
  const auto r = six_feat::layout::PlaceExpandedNodes(MakeRequest(1, {1, 2, 3}, edges, {1, 2}));
  EXPECT_FALSE(r.order.empty());
  for (const auto id : r.order) EXPECT_NE(r.positions.find(id), r.positions.end());
}

TEST(ResolveCollisions, PushesOverlappingNodesApartAndLeavesPinnedOnesAlone) {
  const LayoutParams params;
  std::vector<std::int64_t> order{1, 2, 3};
  std::unordered_map<std::int64_t, Point> targets{
      {1, {0.0, 0.0}}, {2, {4.0, 0.0}}, {3, {8.0, 0.0}}};
  six_feat::layout::ResolveCollisions(order, targets, {1}, {}, nullptr, params);
  EXPECT_DOUBLE_EQ(targets.at(1).x, 0.0);
  EXPECT_DOUBLE_EQ(targets.at(1).y, 0.0);
  for (std::size_t i = 0; i < order.size(); ++i) {
    for (std::size_t j = i + 1; j < order.size(); ++j) {
      const auto& a = targets.at(order[i]);
      const auto& b = targets.at(order[j]);
      EXPECT_GE(std::hypot(a.x - b.x, a.y - b.y), params.MinSep() - 1e-9);
    }
  }
}

TEST(ResolveCollisions, ExactlyCoincidentNodesStillSeparate) {
  const LayoutParams params;
  std::vector<std::int64_t> order{1, 2};
  std::unordered_map<std::int64_t, Point> targets{{1, {5.0, 5.0}}, {2, {5.0, 5.0}}};
  six_feat::layout::ResolveCollisions(order, targets, {}, {}, nullptr, params);
  const double d = std::hypot(targets.at(1).x - targets.at(2).x, targets.at(1).y - targets.at(2).y);
  EXPECT_GE(d, params.MinSep() - 1e-9);
  EXPECT_TRUE(std::isfinite(d));
}

TEST(ResolveCollisions, ExtraPinnedPointsPushWithoutBeingEmitted) {
  const LayoutParams params;
  std::vector<std::int64_t> order{1};
  std::unordered_map<std::int64_t, Point> targets{{1, {3.0, 0.0}}};
  six_feat::layout::ResolveCollisions(order, targets, {}, {{99, {0.0, 0.0}}}, nullptr, params);
  EXPECT_EQ(targets.find(99), targets.end());
  EXPECT_GE(std::hypot(targets.at(1).x, targets.at(1).y), params.MinSep() - 1e-9);
}

}  // namespace
