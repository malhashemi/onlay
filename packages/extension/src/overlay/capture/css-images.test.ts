// Every way an image enters a CSS value is found (C-3).
import { expect, test } from "bun:test";
import { cssUrl, hasImageValue, imagesAsUrls, rewriteImageUrls, withoutImages } from "./css-images";

const DATA = "data:image/png;base64,iVBORw0KGgo=";

test("every image form is recognised, and plain values are not", () => {
  for (const v of [
    'url("a.png")',
    `image-set("${DATA}" 1x)`,
    `-webkit-image-set('${DATA}' 1x)`,
    "cross-fade(url(a.png) 50%, url(b.png))",
    "-webkit-cross-fade(url(a.png), url(b.png), 50%)",
    'image("a.png")',
    'src("a.png")',
    'linear-gradient(red, blue), IMAGE-SET("a.png" 2x)',
  ]) {
    expect(hasImageValue(v)).toBe(true);
  }
  for (const v of ["12px", "linear-gradient(red, blue)", "rgb(1, 2, 3)", "my-image(x)"]) {
    expect(hasImageValue(v)).toBe(false);
  }
});

test("withoutImages leaves no image of any form, and keeps the rest", () => {
  const v = `linear-gradient(red, blue), image-set("${DATA}" 1x, "b.png" 2x), cross-fade(url(a.png), image("c.png")), src("d.png") no-repeat`;
  const out = withoutImages(v);
  expect(out).toBe("linear-gradient(red, blue), none, none, none no-repeat");
  expect(out).not.toContain("data:");
  // A same-document SVG reference is no resource.
  expect(withoutImages('url("#clip")')).toBe('url("#clip")');
  // Strings and comments that only mention a function are not one.
  expect(withoutImages('"url(x)" /* image("y") */')).toBe('"url(x)" /* image("y") */');
});

test("imagesAsUrls puts every image into url() form, so the one url() rewrite sees it", () => {
  expect(imagesAsUrls(`image-set("${DATA}" 1x, 'b.png' 2x)`)).toBe(
    `image-set(url("${DATA}") 1x, url('b.png') 2x)`,
  );
  expect(imagesAsUrls('-webkit-image-set(url("a.png") 1x)')).toBe(
    '-webkit-image-set(url("a.png") 1x)',
  );
  expect(imagesAsUrls('src("a.png")')).toBe('url("a.png")');
  expect(imagesAsUrls('src("a.png" crossorigin(anonymous))')).toBe("none");
  expect(imagesAsUrls('image("a.png", red)')).toBe('image(url("a.png"), red)');
  expect(imagesAsUrls('cross-fade(image-set("a.png" 1x) 30%, url(b.png))')).toBe(
    'cross-fade(image-set(url("a.png") 1x) 30%, url(b.png))',
  );
  expect(imagesAsUrls("linear-gradient(red, blue)")).toBe("linear-gradient(red, blue)");
});

test("rewriteImageUrls hands over each url() whole, quotes off and escapes decoded (2-C2)", () => {
  const seen: string[] = [];
  const out = rewriteImageUrls(
    `url("a(1).png"), image-set('b\\'s).png' 1x), url(c\\).png), url("d\\"q.png")`,
    (target) => {
      seen.push(target);
      return "X";
    },
  );
  expect(seen).toEqual(["a(1).png", "b's).png", "c).png", 'd"q.png']);
  expect(out).toBe("X, image-set(X 1x), X, X");
});

test("cssUrl quotes so the renderer reads the URL as one token", () => {
  expect(cssUrl("data:image/svg+xml,<svg>)</svg>")).toBe('url("data:image/svg+xml,<svg>)</svg>")');
  expect(cssUrl('data:a"b')).toBe("url('data:a\"b')");
  expect(cssUrl(`data:a"b'c`)).toBe(`url("data:a%22b'c")`);
  expect(cssUrl("data:a\\b")).toBe('url("data:a%5Cb")');
});
