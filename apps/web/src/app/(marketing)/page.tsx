import { Features } from "@/components/marketing/features";
import { Footer } from "@/components/marketing/footer";
import { Hero } from "@/components/marketing/hero";
import { Nav } from "@/components/marketing/nav";
import { Roadmap } from "@/components/marketing/roadmap";
import { SelfHost } from "@/components/marketing/self-host";

export default function Home() {
  return (
    <>
      <Nav />
      <main>
        <Hero />
        <Features />
        <SelfHost />
        <Roadmap />
      </main>
      <Footer />
    </>
  );
}
