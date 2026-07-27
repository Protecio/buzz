import {
  ArrowRight,
  Download,
  LockKeyhole,
  Radio,
  ShieldCheck,
} from "lucide-react";

import buzzAppIcon from "@/assets/app-icon@3x.png";

const CONTROL_CENTER_URL = "https://enter.protecio.com/#/habitat";
const TEAM_PREVIEW_URL =
  "https://github.com/Protecio/buzz/releases/tag/protecio-team-preview";

export function HabitatLandingPage() {
  return (
    <div className="min-h-dvh bg-[#0d1117] px-5 py-8 text-white sm:px-8">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between">
        <div className="flex items-center gap-3">
          <img
            alt="Buzz"
            className="h-11 w-11 rounded-[14px]"
            src={buzzAppIcon}
          />
          <div>
            <strong className="block text-base">Protecio Buzz</strong>
            <span className="text-xs text-white/55">Secure Work Habitat</span>
          </div>
        </div>
        <span className="flex items-center gap-2 rounded-full border border-emerald-400/25 bg-emerald-400/10 px-3 py-1.5 text-xs text-emerald-200">
          <Radio className="h-3.5 w-3.5" />
          Relais opérationnel
        </span>
      </header>

      <main className="mx-auto grid w-full max-w-6xl gap-10 pb-16 pt-20 lg:grid-cols-[1.15fr_0.85fr] lg:items-center lg:pt-28">
        <section>
          <span className="text-xs font-semibold uppercase tracking-[0.24em] text-[#85a7ff]">
            Humains et agents, un même espace protégé
          </span>
          <h1 className="mt-5 max-w-3xl text-4xl font-semibold leading-[1.05] tracking-[-0.045em] sm:text-6xl">
            Votre habitat de travail souverain.
          </h1>
          <p className="mt-6 max-w-2xl text-base leading-7 text-white/65 sm:text-lg">
            Buzz relie votre identité Protecio, vos collègues et vos agents dans
            une communauté signée. L’accès est réservé aux tenants autorisés et
            se prépare depuis le Control Center.
          </p>

          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <a
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#5276e8] px-5 py-3 text-sm font-semibold transition hover:bg-[#6285f5]"
              href={CONTROL_CENTER_URL}
            >
              Préparer mon habitat
              <ArrowRight className="h-4 w-4" />
            </a>
            <a
              className="inline-flex items-center justify-center gap-2 rounded-xl border border-white/15 bg-white/[0.06] px-5 py-3 text-sm font-semibold transition hover:bg-white/10"
              href={TEAM_PREVIEW_URL}
            >
              <Download className="h-4 w-4" />
              Télécharger l’app équipe
            </a>
          </div>
          <p className="mt-3 text-xs text-white/40">
            Préversion Windows non signée — réservée aux collaborateurs Protecio
            jusqu’à la signature Microsoft.
          </p>
        </section>

        <section className="rounded-3xl border border-white/10 bg-white/[0.055] p-6 shadow-2xl shadow-black/30 backdrop-blur sm:p-8">
          <div className="flex items-center gap-3 border-b border-white/10 pb-5">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[#5276e8]/20 text-[#9bb4ff]">
              <ShieldCheck className="h-6 w-6" />
            </div>
            <div>
              <strong className="block">Accès gouverné par Protecio</strong>
              <span className="text-sm text-white/50">
                Aucun compte parallèle à administrer
              </span>
            </div>
          </div>
          <ol className="mt-6 space-y-5">
            <Step
              number="1"
              title="Entrez avec votre organisation"
              body="Protecio retrouve votre tenant et les habitats auxquels vous êtes autorisé."
            />
            <Step
              number="2"
              title="Préparez Buzz"
              body="Le Control Center crée un profil sans clé privée ni secret exporté."
            />
            <Step
              number="3"
              title="Ouvrez l’application"
              body="Buzz conserve localement votre identité et rejoint uniquement la communauté autorisée."
            />
          </ol>
          <a
            className="mt-7 flex items-center justify-between rounded-xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-white/70 transition hover:bg-black/30 hover:text-white"
            href="/repos"
          >
            <span className="flex items-center gap-2">
              <LockKeyhole className="h-4 w-4" />
              Dépôts de la communauté
            </span>
            <ArrowRight className="h-4 w-4" />
          </a>
        </section>
      </main>
    </div>
  );
}

function Step({
  number,
  title,
  body,
}: {
  number: string;
  title: string;
  body: string;
}) {
  return (
    <li className="grid grid-cols-[32px_1fr] gap-3">
      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-xs font-semibold text-white/70">
        {number}
      </span>
      <div>
        <strong className="block text-sm">{title}</strong>
        <p className="mt-1 text-sm leading-6 text-white/50">{body}</p>
      </div>
    </li>
  );
}
