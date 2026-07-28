add_library(six_feat_domain STATIC src/role_mask.cpp)

target_include_directories(six_feat_domain PUBLIC include)

target_link_libraries(six_feat_domain PUBLIC userver::core)
