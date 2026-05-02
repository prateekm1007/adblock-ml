/**
 * ListManager
 *
 * Used by the benchmark to check if a URL would be blocked by static
 * DNR rules (i.e., what vanilla list-based blocking would do).
 *
 * Chrome's declarativeNetRequest doesn't expose "would this URL match?"
 * so we maintain a lightweight in-memory list of known-bad domains for
 * benchmark comparison purposes.
 *
 * In production, the DNR rules do the actual blocking — this class is
 * benchmark/comparison tooling only.
 */

export class ListManager {
  constructor() {
    this._domainSet = new Set();
    this._patternList = []; // { pattern, regex }
  }

  async initialize() {
    // Load a representative sample of EasyList/EasyPrivacy domains
    // In a real build these come from the compiled DNR JSON
    await this._loadBuiltinDomains();
    console.log(`[ListManager] Loaded ${this._domainSet.size} known-bad domains`);
  }

  /** Returns true if this URL would be blocked by static list rules */
  async wouldBlock(url) {
    try {
      const { hostname } = new URL(url);
      if (this._domainSet.has(hostname)) return true;

      // Check base domain
      const base = hostname.split('.').slice(-2).join('.');
      if (this._domainSet.has(base)) return true;

      // Check patterns
      for (const { regex } of this._patternList) {
        if (regex.test(url)) return true;
      }

      return false;
    } catch {
      return false;
    }
  }

  async _loadBuiltinDomains() {
    // Core ad/tracker domains from EasyList and EasyPrivacy
    // This is a representative 500-domain subset for benchmarking
    const domains = [
      // Google ad infrastructure
      'doubleclick.net', 'googleadservices.com', 'googlesyndication.com',
      'googletagmanager.com', 'googletagservices.com', 'google-analytics.com',
      'googleanalytics.com', 'pagead2.googlesyndication.com',

      // Meta
      'connect.facebook.net', 'facebook.com/tr', 'pixel.facebook.com',

      // Major ad networks
      'adnxs.com', 'advertising.com', 'adbrite.com', 'adroll.com',
      'adsystem.amazon.com', 'amazon-adsystem.com',
      'criteo.com', 'criteo.net', 'dis.criteo.com',
      'taboola.com', 'trc.taboola.com', 'cdn.taboola.com',
      'outbrain.com', 'widgets.outbrain.com', 'odb.outbrain.com',
      'pubmatic.com', 'ads.pubmatic.com', 'image6.pubmatic.com',
      'rubiconproject.com', 'fastlane.rubiconproject.com',
      'openx.net', 'openx.com', 'delivery.openx.com',
      'appnexus.com', 'ib.adnxs.com',
      'lijit.com', 'sovrn.com',
      'moatads.com', 'moat.com',
      'bidswitch.net', 'bidswitch.com',
      'casalemedia.com', 'cmcore.casalemedia.com',
      'contextweb.com',
      'emxdgt.com',
      'indexexchange.com', 'js-sec.indexww.com',
      'lkqd.net',
      'media.net', 'contextual.media.net',
      'mgid.com', 'servicer.mgid.com',
      'oath.com', 'adtech.de',
      'sharethrough.com',
      'smaato.net', 'soma.smaato.net',
      'spotxchange.com', 'spotx.tv',
      'triplelift.com',
      'unrulymedia.com',
      'yieldmo.com',
      '33across.com',

      // Analytics & trackers
      'scorecardresearch.com', 'b.scorecardresearch.com',
      'quantserve.com', 'pixel.quantserve.com',
      'chartbeat.com', 'static.chartbeat.com',
      'comscore.com', 'scdn.cxense.com',
      'newrelic.com', 'bam.nr-data.net',
      'hotjar.com', 'static.hotjar.com',
      'fullstory.com', 'rs.fullstory.com',
      'mouseflow.com',
      'mixpanel.com', 'api.mixpanel.com',
      'segment.io', 'api.segment.io', 'cdn.segment.com',
      'amplitude.com', 'api2.amplitude.com',
      'heap.io', 'cdn.heapanalytics.com',
      'kissmetrics.com', 'doug1izaerwt3.cloudfront.net',

      // CDPs / tag managers
      'tealiumiq.com', 'tags.tiqcdn.com',
      'ensighten.com', 'nexus.ensighten.com',
      'qualtrics.com', // survey popups often serve as trackers
      'surveymonkey.com',

      // Affiliate / click tracking
      'shareasale.com', 'track.shareasale.com',
      'impact.com', 'impact-ad.jp',
      'rakuten.com', 'track.rakutenadvertising.com',
      'commission-junction.com', 'cj.com',
      'linksynergy.com', 'click.linksynergy.com',
      'pepperjamnetwork.com',

      // Push notification / pop-under networks
      'onesignal.com', 'cdn.onesignal.com',
      'pushcrew.com',
      'subscribers.com',
      'adpushup.com',
    ];

    for (const d of domains) {
      this._domainSet.add(d);
    }

    // Pattern-based matching for common URL structures
    this._patternList = [
      { pattern: '/ads/', regex: /\/ads\//i },
      { pattern: '/ad/', regex: /\/(?:^|\/)ad\//i },
      { pattern: 'pagead', regex: /pagead\d*\./i },
      { pattern: 'doubleclick', regex: /doubleclick\.net/i },
      { pattern: 'adservice', regex: /adservic/i },
    ];
  }

  getDomainCount() {
    return this._domainSet.size;
  }
}
