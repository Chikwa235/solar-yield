

import React, { useMemo, useState } from "react";

// ----- helpers -----
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

function formatMoney(value, currency) {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return `${currency} ${Math.round(value).toLocaleString()}`;
  }
}

function formatNumber(value, digits = 0) {
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: digits,
  }).format(value);
}

/**
 * Compute PV output from irradiation using a simplified industry approximation:
 * - Get daily Global Tilted Irradiance (GTI) in kWh/m²/day (we approximate using shortwave radiation sum)
 * - 1 kWp produces about GTI kWh/day at PR=1.0
 * - Apply Performance Ratio (PR) and losses to get energy.
 *
 * Not a bankable model, but great for sales pre-estimates and comparing scenarios.
 */
function estimateEnergyKWh({
  gtiKWhPerM2Day,
  systemSizeKWp,
  performanceRatio,
}) {
  // Roughly: kWh/day ≈ kWp * GTI * PR
  return systemSizeKWp * gtiKWhPerM2Day * performanceRatio;
}

export default function SolarYieldRevenueForecaster() {
  // Defaults: set to a plausible region; user can change
  const [lat, setLat] = useState(-15.3875); // Lusaka-ish (example)
  const [lon, setLon] = useState(28.3228);

  const [systemSizeKWp, setSystemSizeKWp] = useState(500); // 500 kWp plant
  const [lossesPct, setLossesPct] = useState(14); // wiring, inverter, soiling, mismatch etc.
  const [additionalPRPct, setAdditionalPRPct] = useState(0); // extra derating if needed
  const [tariffPerKWh, setTariffPerKWh] = useState(0.16); // currency per kWh
  const [currency, setCurrency] = useState("USD");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);

  const performanceRatio = useMemo(() => {
    // Base PR ~ 0.86 minus user adjustments
    const base = 1 - lossesPct / 100;
    const extra = 1 - additionalPRPct / 100;
    return clamp(base * extra, 0.5, 0.95);
  }, [lossesPct, additionalPRPct]);

  async function runForecast() {
    setLoading(true);
    setError("");
    setResult(null);

    try {
      // Use Open-Meteo "daily shortwave_radiation_sum" as proxy for GTI.
      // It returns MJ/m²/day. Convert to kWh/m²/day:
      // 1 MJ = 0.277777... kWh
      // docs: https://open-meteo.com/
      const url = new URL("https://api.open-meteo.com/v1/forecast");
      url.searchParams.set("latitude", String(lat));
      url.searchParams.set("longitude", String(lon));
      url.searchParams.set("daily", "shortwave_radiation_sum");
      url.searchParams.set("forecast_days", "14");
      url.searchParams.set("timezone", "auto");

      const r = await fetch(url.toString());
      if (!r.ok) throw new Error(`API request failed (${r.status})`);
      const data = await r.json();

      const days = data?.daily?.time?.length ? data.daily.time.length : 0;
      const radMj = data?.daily?.shortwave_radiation_sum || [];
      if (!days || radMj.length !== days) {
        throw new Error("No radiation data returned for this location.");
      }

      const daily = radMj.map((mj, idx) => {
        const gtiKWhPerM2Day = mj * 0.2777777778;
        const energyKWh = estimateEnergyKWh({
          gtiKWhPerM2Day,
          systemSizeKWp,
          performanceRatio,
        });

        return {
          date: data.daily.time[idx],
          gtiKWhPerM2Day,
          energyKWh,
          revenue: energyKWh * tariffPerKWh,
        };
      });

      const avgDailyKWh = daily.reduce((a, d) => a + d.energyKWh, 0) / daily.length;
      const annualKWh = avgDailyKWh * 365;
      const monthlyKWh = annualKWh / 12;

      const annualRevenue = annualKWh * tariffPerKWh;
      const monthlyRevenue = annualRevenue / 12;

      const capacityFactor =
        annualKWh / (systemSizeKWp * 8760); // CF = actual / (kW * hours)
      const capFactorPct = capacityFactor * 100;

      // build a “report” object
      setResult({
        location: {
          latitude: lat,
          longitude: lon,
          timezone: data.timezone,
          elevation: data.elevation,
        },
        inputs: {
          systemSizeKWp,
          lossesPct,
          additionalPRPct,
          performanceRatio,
          tariffPerKWh,
          currency,
        },
        outputs: {
          avgDailyKWh,
          monthlyKWh,
          annualKWh,
          monthlyRevenue,
          annualRevenue,
          capacityFactorPct: capFactorPct,
        },
        daily,
      });
    } catch (e) {
      setError(e?.message || "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-black text-white">
      <div className="mx-auto max-w-6xl px-6 py-12">
        <div className="flex flex-col gap-2">
          <div className="inline-flex w-fit items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-xs text-white/80">
            Solar Yield + Revenue Forecaster
          </div>

          <h1 className="text-3xl md:text-5xl font-semibold tracking-tight">
            Forecast generation & revenue in minutes
          </h1>

          <p className="text-white/65 max-w-3xl">
            Designed for solar EPC / plant teams. Use this to estimate energy yield,
            capacity factor, and revenue/savings from a proposed PV system using real
            irradiation forecasts.
          </p>
        </div>

        {/* Inputs */}
        <div className="mt-10 grid lg:grid-cols-12 gap-6">
          <div className="lg:col-span-5 rounded-3xl border border-white/10 bg-white/5 p-6">
            <h2 className="text-lg font-semibold">Inputs</h2>

            <div className="mt-5 grid grid-cols-2 gap-3">
              <label className="text-sm text-white/70">
                Latitude
                <input
                  value={lat}
                  onChange={(e) => setLat(Number(e.target.value))}
                  type="number"
                  step="0.0001"
                  className="mt-1 w-full rounded-xl bg-black/40 border border-white/10 px-3 py-2 text-white outline-none focus:border-emerald-400/50"
                />
              </label>

              <label className="text-sm text-white/70">
                Longitude
                <input
                  value={lon}
                  onChange={(e) => setLon(Number(e.target.value))}
                  type="number"
                  step="0.0001"
                  className="mt-1 w-full rounded-xl bg-black/40 border border-white/10 px-3 py-2 text-white outline-none focus:border-emerald-400/50"
                />
              </label>

              <label className="text-sm text-white/70 col-span-2">
                System size (kWp)
                <input
                  value={systemSizeKWp}
                  onChange={(e) => setSystemSizeKWp(Number(e.target.value))}
                  type="number"
                  min="1"
                  step="1"
                  className="mt-1 w-full rounded-xl bg-black/40 border border-white/10 px-3 py-2 text-white outline-none focus:border-emerald-400/50"
                />
              </label>

              <label className="text-sm text-white/70">
                Losses (%)
                <input
                  value={lossesPct}
                  onChange={(e) => setLossesPct(Number(e.target.value))}
                  type="number"
                  min="0"
                  max="40"
                  step="0.5"
                  className="mt-1 w-full rounded-xl bg-black/40 border border-white/10 px-3 py-2 text-white outline-none focus:border-emerald-400/50"
                />
              </label>

              <label className="text-sm text-white/70">
                Extra derating (%)
                <input
                  value={additionalPRPct}
                  onChange={(e) => setAdditionalPRPct(Number(e.target.value))}
                  type="number"
                  min="0"
                  max="30"
                  step="0.5"
                  className="mt-1 w-full rounded-xl bg-black/40 border border-white/10 px-3 py-2 text-white outline-none focus:border-emerald-400/50"
                />
              </label>

              <label className="text-sm text-white/70">
                Tariff / kWh
                <input
                  value={tariffPerKWh}
                  onChange={(e) => setTariffPerKWh(Number(e.target.value))}
                  type="number"
                  min="0"
                  step="0.01"
                  className="mt-1 w-full rounded-xl bg-black/40 border border-white/10 px-3 py-2 text-white outline-none focus:border-emerald-400/50"
                />
              </label>

              <label className="text-sm text-white/70">
                Currency
                <select
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value)}
                  className="mt-1 w-full rounded-xl bg-black/40 border border-white/10 px-3 py-2 text-white outline-none focus:border-emerald-400/50"
                >
                  <option value="USD">USD</option>
                  <option value="ZMW">ZMW</option>
                  <option value="EUR">EUR</option>
                  <option value="GBP">GBP</option>
                </select>
              </label>
            </div>

            <div className="mt-4 rounded-2xl border border-white/10 bg-black/30 p-4">
              <div className="text-xs text-white/60">Performance Ratio (PR)</div>
              <div className="mt-1 text-xl font-semibold text-emerald-300">
                {formatNumber(performanceRatio * 100, 1)}%
              </div>
              <p className="mt-1 text-xs text-white/55">
                PR is a simplified factor capturing real-world losses. For quick proposals,
                0.75–0.88 is typical depending on design & soiling.
              </p>
            </div>

            <button
              onClick={runForecast}
              disabled={loading}
              className="mt-5 w-full rounded-2xl bg-emerald-500 px-5 py-3 text-black font-semibold hover:bg-emerald-400 disabled:opacity-60"
            >
              {loading ? "Forecasting..." : "Run forecast (14-day solar input)"}
            </button>

            {error ? (
              <div className="mt-4 rounded-2xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200">
                {error}
              </div>
            ) : null}

            <p className="mt-4 text-xs text-white/50">
              Data source: Open‑Meteo shortwave radiation forecast (proxy for irradiance).
              Output is a pre‑sales estimate—not a bankable P50/P90 study.
            </p>
          </div>

          {/* Results */}
          <div className="lg:col-span-7 rounded-3xl border border-white/10 bg-white/5 p-6">
            <h2 className="text-lg font-semibold">Results</h2>

            {!result ? (
              <div className="mt-6 rounded-2xl border border-white/10 bg-black/30 p-6 text-white/70">
                Run the forecast to generate yield and revenue estimates.
              </div>
            ) : (
              <>
                <div className="mt-6 grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  <div className="rounded-2xl border border-white/10 bg-black/30 p-5">
                    <div className="text-xs text-white/60">Avg daily energy</div>
                    <div className="mt-1 text-2xl font-semibold">
                      {formatNumber(result.outputs.avgDailyKWh, 0)} kWh
                    </div>
                  </div>

                  <div className="rounded-2xl border border-white/10 bg-black/30 p-5">
                    <div className="text-xs text-white/60">Annual energy (est.)</div>
                    <div className="mt-1 text-2xl font-semibold">
                      {formatNumber(result.outputs.annualKWh, 0)} kWh
                    </div>
                  </div>

                  <div className="rounded-2xl border border-emerald-400/20 bg-emerald-500/10 p-5">
                    <div className="text-xs text-emerald-200/80">Annual revenue (est.)</div>
                    <div className="mt-1 text-2xl font-semibold">
                      {formatMoney(result.outputs.annualRevenue, result.inputs.currency)}
                    </div>
                  </div>

                  <div className="rounded-2xl border border-white/10 bg-black/30 p-5">
                    <div className="text-xs text-white/60">Monthly energy (est.)</div>
                    <div className="mt-1 text-2xl font-semibold">
                      {formatNumber(result.outputs.monthlyKWh, 0)} kWh
                    </div>
                  </div>

                  <div className="rounded-2xl border border-white/10 bg-black/30 p-5">
                    <div className="text-xs text-white/60">Monthly revenue (est.)</div>
                    <div className="mt-1 text-2xl font-semibold">
                      {formatMoney(result.outputs.monthlyRevenue, result.inputs.currency)}
                    </div>
                  </div>

                  <div className="rounded-2xl border border-white/10 bg-black/30 p-5">
                    <div className="text-xs text-white/60">Capacity factor (est.)</div>
                    <div className="mt-1 text-2xl font-semibold">
                      {formatNumber(result.outputs.capacityFactorPct, 1)}%
                    </div>
                  </div>
                </div>

                <div className="mt-6 rounded-2xl border border-white/10 bg-black/30 p-5">
                  <div className="text-sm font-semibold">Proposal summary (copy/paste)</div>
                  <div className="mt-2 text-sm text-white/70 leading-relaxed">
                    Location: {formatNumber(result.location.latitude, 4)},{" "}
                    {formatNumber(result.location.longitude, 4)} • PR:{" "}
                    {formatNumber(result.inputs.performanceRatio * 100, 1)}% • Size:{" "}
                    {formatNumber(result.inputs.systemSizeKWp, 0)} kWp
                    <br />
                    Est. annual energy:{" "}
                    <span className="text-white font-semibold">
                      {formatNumber(result.outputs.annualKWh, 0)} kWh
                    </span>{" "}
                    • Est. annual value:{" "}
                    <span className="text-emerald-300 font-semibold">
                      {formatMoney(result.outputs.annualRevenue, result.inputs.currency)}
                    </span>
                  </div>
                </div>

                <div className="mt-8">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold">Next 14 days (solar input → output estimate)</h3>
                    <div className="text-xs text-white/50">
                      Irradiance proxy: shortwave radiation sum
                    </div>
                  </div>

                  <div className="mt-3 overflow-auto rounded-2xl border border-white/10">
                    <table className="w-full text-sm">
                      <thead className="bg-white/5 text-white/70">
                        <tr>
                          <th className="text-left px-4 py-3">Date</th>
                          <th className="text-right px-4 py-3">Irradiance (kWh/m²)</th>
                          <th className="text-right px-4 py-3">Energy (kWh)</th>
                          <th className="text-right px-4 py-3">Value</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/10">
                        {result.daily.map((d) => (
                          <tr key={d.date} className="bg-black/20">
                            <td className="px-4 py-3">{d.date}</td>
                            <td className="px-4 py-3 text-right">
                              {formatNumber(d.gtiKWhPerM2Day, 2)}
                            </td>
                            <td className="px-4 py-3 text-right">
                              {formatNumber(d.energyKWh, 0)}
                            </td>
                            <td className="px-4 py-3 text-right">
                              {formatMoney(d.revenue, result.inputs.currency)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <p className="mt-3 text-xs text-white/50">
                    Tip: For a “Mailo Solar Plant” demo, set system size to the plant’s MWp and currency to ZMW, then use their PPA/tariff.
                  </p>
                </div>
              </>
            )}
          </div>
        </div>

        <div className="mt-10 text-xs text-white/45">
          Built a proposal prototype. Next improvements: P50/P90 scenarios, seasonal irradiance (TMY), battery/hybrid dispatch, diesel offset, and PDF export.
        </div>
      </div>
    </div>
  );
}