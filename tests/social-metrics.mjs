import assert from 'node:assert/strict'
import {
  compactSocialMetric,
  generateSocialMetrics,
  generateSocialMetricsForViews,
  normalizeSocialMetricProfile,
  normalizeSocialMetricScale,
  SOCIAL_METRIC_PROFILES,
  SOCIAL_METRIC_SCALES,
} from '../src/socialMetrics.ts'

function seededRandom(seed = 1729) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 2 ** 32
  }
}

assert.equal(normalizeSocialMetricScale(undefined), 'daily')
assert.equal(normalizeSocialMetricScale('unknown'), 'daily')
assert.equal(normalizeSocialMetricProfile(undefined), 'resonance')
assert.equal(normalizeSocialMetricProfile('unknown'), 'resonance')
assert.equal(compactSocialMetric(0), '0')
assert.equal(compactSocialMetric(770), '770')
assert.equal(compactSocialMetric(9_234), '9.2K')
assert.equal(compactSocialMetric(12_734), '12.7K')
assert.equal(compactSocialMetric(999_999), '999.9K')
assert.equal(compactSocialMetric(1_000_000), '1M')
assert.equal(compactSocialMetric(1_372_000), '1.3M')

let sampleCount = 0
const summaries = []
for (const scale of SOCIAL_METRIC_SCALES) {
  assert.equal(normalizeSocialMetricScale(scale.value), scale.value)
  for (const profile of SOCIAL_METRIC_PROFILES) {
    assert.equal(normalizeSocialMetricProfile(profile.value), profile.value)
    const random = seededRandom()
    let zeros = 0
    let uneven = 0
    const totals = { views: 0, likes: 0, replies: 0, reposts: 0 }
    for (let i = 0; i < 1_000; i++) {
      const metrics = generateSocialMetrics(scale.value, profile.value, random)
      assert.ok(metrics.views >= scale.views[0] && metrics.views <= scale.views[1])
      assert.ok(metrics.likes > metrics.replies && metrics.likes > metrics.reposts)
      assert.ok(metrics.likes <= metrics.views * 0.04, `${profile.value}: ordinary likes must never exceed 4% of exposure`)
      assert.ok(metrics.replies <= metrics.views * 0.003 + 1, `${profile.value}: replies must stay within the ordinary ceiling, allowing one-count rounding`)
      assert.ok(metrics.reposts <= metrics.views * 0.0015 + 1, `${profile.value}: reposts must stay within the ordinary ceiling, allowing one-count rounding`)
      if (metrics.views <= 5_000) assert.ok(metrics.likes >= metrics.views * 0.01)
      for (const key of Object.keys(totals)) {
        assert.ok(Number.isInteger(metrics[key]) && metrics[key] >= 0)
        totals[key] += metrics[key]
      }
      if (scale.value === 'subtle') {
        assert.ok(metrics.replies <= 3 && metrics.reposts <= 1)
        if (metrics.replies === 0 && metrics.reposts === 0) zeros++
      }
      if (scale.value === 'viral') {
        assert.ok(metrics.likes / metrics.views < 0.021)
        assert.ok(metrics.replies >= metrics.likes * 0.01)
        assert.ok(metrics.reposts >= metrics.likes * 0.004)
      }
      if (metrics.likes % 10 !== 0) uneven++
      sampleCount++
    }
    if (scale.value === 'subtle') assert.ok(zeros > (profile.value === 'resonance' ? 100 : 0), `${profile.value}: small posts should allow no replies or reposts`)
    if (profile.value !== 'informative' && profile.value !== 'news') assert.ok(totals.reposts < totals.replies)
    assert.ok(uneven > 700, 'raw likes should retain natural integer variation')
    summaries.push({ scale: scale.value, profile: profile.value, ...Object.fromEntries(Object.entries(totals).map(([key, total]) => [key, total / 1_000])) })
  }
}

// Matched response distributions isolate reach: larger audiences increase all
// absolute counts while diluting each interaction rate, for every content type.
for (const profile of SOCIAL_METRIC_PROFILES) {
  let previous
  for (const views of [1_000, 10_000, 100_000, 1_000_000]) {
    const random = seededRandom(42)
    const means = { likes: 0, replies: 0, reposts: 0 }
    for (let i = 0; i < 1_000; i++) {
      const metrics = generateSocialMetricsForViews(views, profile.value, random)
      for (const key of Object.keys(means)) means[key] += metrics[key] / 1_000
      sampleCount++
    }
    if (previous) {
      for (const key of Object.keys(means)) {
        assert.ok(means[key] > previous[key], `${profile.value}: ${key} should grow with reach`)
        assert.ok(means[key] / views < previous[key] / previous.views, `${profile.value}: ${key} rate should fall with reach`)
      }
    }
    previous = { views, ...means }
  }
}

const rising = Object.fromEntries(summaries.filter((row) => row.scale === 'rising').map((row) => [row.profile, row]))
assert.ok(rising.resonance.likes > rising.question.likes)
assert.ok(rising.question.replies > rising.resonance.replies * 2)
assert.ok(rising.informative.reposts > rising.resonance.reposts * 2)
assert.ok(rising.informative.reposts > rising.informative.replies)
assert.ok(rising.controversy.replies > rising.question.replies)
assert.ok(rising.news.replies > rising.resonance.replies)
assert.ok(rising.news.reposts > rising.resonance.reposts)

// Cover the actual UI entry point's randomly selected content shapes as well
// as the explicit profiles, so no hidden high-like preset can escape the cap.
const ordinaryRandom = seededRandom(99)
for (let i = 0; i < 5_000; i++) {
  const metrics = generateSocialMetrics('daily', undefined, ordinaryRandom)
  assert.ok(metrics.likes <= metrics.views * 0.04)
  assert.ok(metrics.replies <= metrics.views * 0.003 + 1)
  assert.ok(metrics.reposts <= metrics.views * 0.0015 + 1)
  sampleCount++
}
console.log(`Social metrics: ${sampleCount.toLocaleString('en-US')} seeded samples passed across five exposure bands and five content types.`)
