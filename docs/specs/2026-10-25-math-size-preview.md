# Math sizing preview

Status: reviewed, approved and published in v1.0.21. The maintainer requested larger
numerals and modestly larger side controls while keeping ample whitespace,
reviewed the rendered preview, and then explicitly requested deployment.

Adjust the existing stylesheet, retaining the current interaction layout and
number ranges. Aim for approximately 20–25% larger main numerals and partner
whole/part numerals, approximately 6–8% wider side controls, and a smaller
increase in control text. Picker numerals and equations may grow modestly where
they fit. Keep navigation anchors, the shared doors, the passive mathematical
objects and the black bottom-right rest area.

Maintain clear separation between the whole, its parts, counter groups and
equation. Both frames of a part above ten must remain fully visible. Review
ordinary quantities as well as fifty and the extreme partitions of twenty.
Verify the existing geometry and interaction checks at 1920×1080 and 1280×720.

Show actual rendered previews of Numbers and Number partners, including the
larger-number case. Provide original-size images for review. No runtime logic,
saved-state format or app selection changes are part of this work. Deployment
uses the normal suite update; the website presentation remains unchanged.

The current candidate increases main numerals about 23%, rail width 6.7%, and
control labels 5.4%. The right-hand action rows are 5% taller, with a generous
passive rest row below them. Deploy this reviewed sizing without further
layout changes unless combined validation finds a regression.
