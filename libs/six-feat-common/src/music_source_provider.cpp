#include <six-feat-common/music_source_provider.hpp>

namespace six_feat {

const char* ToString(EdgeSource source) {
  switch (source) {
    case EdgeSource::kGeniusCredit:
      return "genius_credit";
  }
  return "unknown";
}

}  // namespace six_feat
