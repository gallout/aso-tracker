import { gunzipSync } from "node:zlib";
import { createCipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
//#region aso-keywords/server/search-transport.ts
function searchTransportConfig() {
	const file = join(process.env.ASO_STUDIO_HOME || join(homedir(), ".aso-studio"), "keywords", "egress.json");
	const config = process.env.KEYWORDS_EGRESS_URL ? {
		url: process.env.KEYWORDS_EGRESS_URL,
		secret: process.env.KEYWORDS_EGRESS_SECRET
	} : existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
	if (!config) return null;
	const parsed = new URL(config.url);
	if (parsed.protocol !== "https:" || parsed.username || parsed.password || !config.secret || typeof config.secret !== "string") throw new Error("Invalid ASO egress configuration");
	return {
		url: parsed.toString(),
		secret: config.secret
	};
}
async function fetchSearch(url, init) {
	const config = searchTransportConfig();
	if (!config) return fetch(url, init);
	const target = new URL(url);
	if (target.hostname !== "search.itunes.apple.com" || target.protocol !== "https:") throw new Error("Invalid native search target");
	const proxy = new URL(config.url);
	proxy.searchParams.set("url", url);
	const headers = new Headers(init.headers);
	headers.set("x-egress-secret", config.secret);
	if (!headers.has("user-agent")) headers.set("user-agent", "aso-studio/1.0");
	return fetch(proxy, {
		...init,
		headers,
		redirect: "error"
	});
}
//#endregion
//#region aso-keywords/server/itunes.ts
var RateLimited = class extends Error {
	constructor(msg) {
		super(msg);
		this.name = "RateLimited";
	}
};
//#endregion
//#region aso-keywords/server/native-search.ts
const RANKING_SOURCE = "appstore-native-search-200-v1";
const STORES = {
	ae: 143481,
	au: 143460,
	br: 143503,
	ca: 143455,
	cn: 143465,
	cz: 143489,
	de: 143443,
	dk: 143458,
	es: 143454,
	fi: 143447,
	fr: 143442,
	gb: 143444,
	gr: 143448,
	hr: 143494,
	hu: 143482,
	id: 143476,
	il: 143491,
	in: 143467,
	it: 143450,
	jp: 143462,
	kr: 143466,
	kz: 143517,
	mx: 143468,
	my: 143473,
	nl: 143452,
	no: 143457,
	pl: 143478,
	pt: 143453,
	ro: 143487,
	ru: 143469,
	sa: 143479,
	se: 143456,
	si: 143499,
	sk: 143496,
	th: 143475,
	tr: 143480,
	tw: 143470,
	ua: 143492,
	us: 143441,
	vn: 143471
};
const LANG$1 = {
	ae: "ar",
	au: "en-AU",
	br: "pt-BR",
	ca: "en-CA",
	cn: "zh-CN",
	cz: "cs",
	de: "de-DE",
	dk: "da",
	es: "es-ES",
	fi: "fi",
	fr: "fr-FR",
	gb: "en-GB",
	gr: "el",
	hr: "hr",
	hu: "hu",
	id: "id",
	il: "he",
	in: "en-IN",
	it: "it-IT",
	jp: "ja",
	kr: "ko",
	kz: "ru",
	mx: "es-MX",
	my: "ms",
	nl: "nl",
	no: "nb",
	pl: "pl",
	pt: "pt-PT",
	ro: "ro",
	ru: "ru",
	sa: "ar",
	se: "sv",
	si: "sl",
	sk: "sk",
	th: "th",
	tr: "tr",
	tw: "zh-TW",
	ua: "uk",
	us: "en-US",
	vn: "vi"
};
const VARIANTS = {
	"es-ca": "ca",
	"in-hi": "hi",
	"in-ta": "ta",
	"in-gu": "gu",
	"in-kn": "kn",
	"in-ml": "ml",
	"in-mr": "mr",
	"in-or": "or",
	"in-pa": "pa",
	"in-te": "te"
};
function nativeSearchRequest(locale, keyword) {
	const country = locale === "es-ca" ? "es" : locale.startsWith("in-") && VARIANTS[locale] ? "in" : locale;
	const storefront = STORES[country];
	if (!storefront) throw new Error(`Unsupported native App Store storefront: ${locale}; no rank recorded`);
	const language = VARIANTS[locale] ?? LANG$1[country];
	const url = new URL("https://search.itunes.apple.com/WebObjects/MZStore.woa/wa/search");
	url.searchParams.set("clientApplication", "Software");
	url.searchParams.set("media", "software");
	url.searchParams.set("term", keyword);
	return {
		url: url.toString(),
		country,
		storefront,
		language,
		headers: {
			Accept: "application/json",
			"X-Apple-Store-Front": `${storefront},24 t:native`,
			"Accept-Language": language
		}
	};
}
const responseDetails = /* @__PURE__ */ new WeakMap();
function parseNativeSearch(payload, locale, keyword) {
	const request = nativeSearchRequest(locale, keyword);
	const data = payload?.storePlatformData?.["native-search-lockup-search"];
	const store = data?.meta?.storefront;
	if (payload?.term !== keyword) throw new Error("Native search context mismatch; no rank recorded");
	if (!store && payload.metricsBase?.page === "Search_NoResults" && payload.metricsBase.storeFront === String(request.storefront) && payload.metricsBase.storeFrontHeader === request.headers["X-Apple-Store-Front"] && Array.isArray(payload.bubbles) && payload.bubbles.length === 0) {
		const results = [];
		responseDetails.set(results, {
			reportedTotal: 0,
			partial: false,
			empty: true
		});
		return results;
	}
	if (store?.cc?.toLowerCase() !== request.country || String(store?.id) !== String(request.storefront)) throw new Error("Native search context mismatch; no rank recorded");
	const bubble = payload.bubbles?.find((b) => b.name === "software");
	if (!bubble || !Array.isArray(bubble.results)) throw new Error("Native software results missing; no rank recorded");
	if (!Number.isSafeInteger(bubble.totalCount) || (bubble.totalCount ?? -1) < 0 || bubble.results.length > (bubble.totalCount ?? 0) || !bubble.results.length && bubble.totalCount !== 0) throw new Error("Invalid native search count; no rank recorded");
	const seen = /* @__PURE__ */ new Set();
	const results = bubble.results.slice(0, 200).map((item) => {
		const id = Number(item.id);
		if (!["software", "iphoneAppBundle"].includes(item.entity ?? "") || !Number.isSafeInteger(id) || id <= 0 || seen.has(id)) throw new Error("Invalid or duplicate search app ID; no rank recorded");
		seen.add(id);
		const meta = data?.results?.[String(id)];
		return {
			trackId: id,
			trackName: meta?.name ?? `App ${id}`,
			bundleId: meta?.bundleId,
			artistName: meta?.artistName ?? ""
		};
	});
	responseDetails.set(results, {
		effectiveLanguage: data?.meta?.language?.tag,
		reportedTotal: bubble.totalCount,
		partial: results.length < Math.min(200, bubble.totalCount),
		empty: results.length === 0
	});
	return results;
}
function searchEvidence(locale, keyword, results) {
	const request = nativeSearchRequest(locale, keyword);
	return {
		source: RANKING_SOURCE,
		url: request.url,
		storefront: request.storefront,
		country: request.country,
		requestedLanguage: request.language,
		...responseDetails.get(results),
		language: responseDetails.get(results)?.effectiveLanguage ?? null,
		transport: searchTransportConfig() ? "self-hosted-egress" : "direct",
		maxDepth: 200,
		checkedDepth: results.length,
		orderedApps: results.map((a) => ({
			id: a.trackId,
			name: a.trackName
		}))
	};
}
let nextRequestAt = 0;
const pending = /* @__PURE__ */ new Map();
async function searchAppStore(locale, keyword, { sleepMs = 3e3 } = {}) {
	const request = nativeSearchRequest(locale, keyword), key = `${request.country}|${request.language}|${keyword}`;
	const existing = pending.get(key);
	if (existing) return existing;
	const task = (async () => {
		const slot = Math.max(Date.now(), nextRequestAt);
		nextRequestAt = slot + Math.max(1e3, sleepMs);
		if (slot > Date.now()) await new Promise((r) => setTimeout(r, slot - Date.now()));
		const response = await fetchSearch(request.url, {
			headers: request.headers,
			signal: AbortSignal.timeout(3e4)
		});
		if ([
			403,
			429,
			502,
			503,
			504
		].includes(response.status)) throw new RateLimited(`App Store HTTP ${response.status}; no rank recorded`);
		if (!response.ok) throw new Error(`App Store HTTP ${response.status}; no rank recorded`);
		const payload = await response.json();
		try {
			return parseNativeSearch(payload, locale, keyword);
		} catch (error) {
			error.evidence = {
				term: payload?.term,
				metrics: payload?.metricsBase,
				metadata: payload?.storePlatformData?.["native-search-lockup-search"]?.meta,
				bubbles: payload?.bubbles
			};
			throw error;
		}
	})();
	pending.set(key, task);
	try {
		return await task;
	} finally {
		pending.delete(key);
	}
}
//#endregion
//#region aso-keywords/server/appstore-search.ts
const COUNTRY = { "es-ca": "es" };
const LANG = {
	"es-ca": "ca",
	"in-hi": "hi",
	"in-gu": "gu",
	"in-kn": "kn",
	"in-ml": "ml",
	"in-mr": "mr",
	"in-or": "or",
	"in-pa": "pa",
	"in-ta": "ta",
	"in-te": "te"
};
function appStoreSearchURL(locale, keyword) {
	const country = locale.startsWith("in-") ? "in" : COUNTRY[locale] ?? locale;
	if (!/^[a-z]{2}$/.test(country)) throw new Error(`Unsupported storefront: ${locale}`);
	const url = new URL(`https://apps.apple.com/${country}/iphone/search`);
	url.searchParams.set("term", keyword);
	if (LANG[locale]) url.searchParams.set("l", LANG[locale]);
	return url.toString();
}
function findAppStorePosition(results, appId) {
	const index = results.findIndex((app) => String(app.trackId) === appId);
	return {
		position: index < 0 ? null : index + 1,
		total: results.length,
		top5: results.slice(0, 6).map((app, i) => ({
			name: app.trackName ?? "",
			id: app.bundleId ?? "",
			dev: app.artistName ?? "",
			tid: app.trackId,
			pos: i + 1
		}))
	};
}
//#endregion
//#region tools/aso-actions/collector.ts
async function collect() {
	const input = JSON.parse(gunzipSync(Buffer.from(process.env.ASO_SNAPSHOT_INPUT || "", "base64")).toString());
	const app = input.apps.find((a) => a.id === process.env.ASO_APP_ID);
	const key = Buffer.from(process.env.ASO_SNAPSHOT_OUTPUT_KEY || "", "base64");
	if (!app || key.length !== 32 || !/^[a-z0-9-]+$/.test(app.id)) throw new Error("Invalid private snapshot input");
	const tasks = Object.entries(app.keywords).flatMap(([locale, list]) => list.map((keyword) => ({
		locale,
		keyword
	})));
	const records = [];
	let blocked = 0;
	const startedAt = (/* @__PURE__ */ new Date()).toISOString();
	function save() {
		const report = {
			version: 1,
			source: RANKING_SOURCE,
			batchId: input.batchId,
			date: input.date,
			appId: app.id,
			iTunesId: app.iTunesId,
			total: tasks.length,
			completed: records.length,
			records,
			startedAt,
			updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
			runId: process.env.GITHUB_RUN_ID
		};
		const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, nonce);
		cipher.setAAD(Buffer.from(input.batchId + "|" + app.id));
		const encrypted = Buffer.concat([cipher.update(JSON.stringify(report)), cipher.final()]);
		writeFileSync(`snapshot-${app.id}.enc`, JSON.stringify({
			version: 1,
			nonce: nonce.toString("base64"),
			tag: cipher.getAuthTag().toString("base64"),
			data: encrypted.toString("base64")
		}));
	}
	for (const task of tasks) {
		let error;
		try {
			const results = await searchAppStore(task.locale, task.keyword, { sleepMs: 2500 });
			const rank = findAppStorePosition(results, app.iTunesId);
			blocked = 0;
			records.push({
				date: input.date,
				app: app.id,
				locale: task.locale,
				keyword: task.keyword,
				...rank,
				source: RANKING_SOURCE,
				sourceUrl: appStoreSearchURL(task.locale, task.keyword),
				evidence: {
					...searchEvidence(task.locale, task.keyword, results),
					transport: "github-actions",
					runId: process.env.GITHUB_RUN_ID
				}
			});
		} catch (e) {
			error = e.message;
			records.push({
				date: input.date,
				app: app.id,
				locale: task.locale,
				keyword: task.keyword,
				position: null,
				total: 0,
				top5: [],
				source: RANKING_SOURCE,
				error,
				evidence: {
					diagnostic: e.evidence,
					transport: "github-actions",
					runId: process.env.GITHUB_RUN_ID
				}
			});
			if (/HTTP (403|429)/.test(error)) {
				blocked++;
				if (blocked >= 3) {
					save();
					throw new Error("Runner source unavailable; partial encrypted checkpoint saved");
				}
				await new Promise((r) => setTimeout(r, 6e4));
			}
		}
		if (records.length % 20 === 0) {
			save();
			console.log(`${app.id}: ${records.length}/${tasks.length}`);
		}
	}
	save();
	console.log(`${app.id}: ${records.length}/${tasks.length} completed`);
}
collect().catch(() => {
	console.error("Snapshot stopped; inspect encrypted checkpoint for details");
	process.exitCode = 1;
});
//#endregion
export { collect };
