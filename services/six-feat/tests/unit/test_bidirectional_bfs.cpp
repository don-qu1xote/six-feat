#include <gtest/gtest.h>
#include <six-feat-storage/analytics.hpp>

namespace six_feat::test {
namespace {

TEST(BidirectionalBfs, EmptyGraphReturnsNoPath) {
  const AdjList adj;
  const auto path = BidirectionalBfs(adj, 1, 2);
  EXPECT_TRUE(path.empty());
}

TEST(BidirectionalBfs, SeedEqualsGoalReturnsSingleNodePath) {
  AdjList adj;
  adj[1] = {{2, 1}};
  const auto path = BidirectionalBfs(adj, 1, 1);
  ASSERT_EQ(path.size(), 1u);
  EXPECT_EQ(path[0], 1);
}

TEST(BidirectionalBfs, SeedEqualsGoalOnEmptyGraphStillReturnsSingleNode) {
  const AdjList adj;
  const auto path = BidirectionalBfs(adj, 5, 5);
  ASSERT_EQ(path.size(), 1u);
  EXPECT_EQ(path[0], 5);
}

TEST(BidirectionalBfs, FindsShortestPathOnSmallFixedGraph) {
  AdjList adj;
  adj[1] = {{2, 1}};
  adj[2] = {{1, 1}, {3, 1}, {5, 1}};
  adj[3] = {{2, 1}, {4, 1}};
  adj[4] = {{3, 1}};
  adj[5] = {{2, 1}};

  const auto path = BidirectionalBfs(adj, 1, 4);

  const std::vector<std::int64_t> expected{1, 2, 3, 4};
  EXPECT_EQ(path, expected);
}

TEST(BidirectionalBfs, DirectNeighboursReturnTwoNodePath) {
  AdjList adj;
  adj[1] = {{2, 1}};
  adj[2] = {{1, 1}};

  const auto path = BidirectionalBfs(adj, 1, 2);

  const std::vector<std::int64_t> expected{1, 2};
  EXPECT_EQ(path, expected);
}

TEST(BidirectionalBfs, DisconnectedNodesReturnNoPath) {
  AdjList adj;
  adj[1] = {{2, 1}};
  adj[2] = {{1, 1}};
  adj[10] = {{11, 1}};
  adj[11] = {{10, 1}};

  const auto path = BidirectionalBfs(adj, 1, 10);

  EXPECT_TRUE(path.empty());
}

TEST(BidirectionalBfs, MissingNodeReturnsNoPath) {
  AdjList adj;
  adj[1] = {{2, 1}};
  adj[2] = {{1, 1}};

  const auto path = BidirectionalBfs(adj, 1, 999);

  EXPECT_TRUE(path.empty());
}

}  // namespace
}  // namespace six_feat::test
