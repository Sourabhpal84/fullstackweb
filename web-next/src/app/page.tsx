import { HomeExperience } from "@/components/home/home-experience";
import { JsonLd } from "@/components/seo/json-ld";
import { structuredDataGraph } from "@/lib/seo";

export default function Page() {
  return (
    <>
      <JsonLd data={structuredDataGraph()} />
      <HomeExperience />
    </>
  );
}
