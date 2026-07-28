cmake_minimum_required(VERSION 3.22)
project(six_feat CXX)

add_subdirectory(services/six-feat)
add_subdirectory(services/auth)
add_subdirectory(services/enrichment)
add_subdirectory(services/genius-gateway)
add_subdirectory(services/game)
