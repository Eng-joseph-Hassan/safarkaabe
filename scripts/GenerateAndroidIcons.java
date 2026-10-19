import java.awt.Color;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.io.File;
import javax.imageio.ImageIO;

public final class GenerateAndroidIcons {
    private static final String[] DENSITIES = {"mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"};
    private static final int[] ICON_SIZES = {48, 72, 96, 144, 192};
    private static final int[] WEB_SIZES = {16, 32, 48, 64, 128, 180, 192, 256, 512};
    private static final String[][] SPLASH_ASSETS = {
        {"drawable/splash.png", "480", "320"},
        {"drawable-land-mdpi/splash.png", "480", "320"},
        {"drawable-land-hdpi/splash.png", "800", "480"},
        {"drawable-land-xhdpi/splash.png", "1280", "720"},
        {"drawable-land-xxhdpi/splash.png", "1600", "960"},
        {"drawable-land-xxxhdpi/splash.png", "1920", "1280"},
        {"drawable-port-mdpi/splash.png", "320", "480"},
        {"drawable-port-hdpi/splash.png", "480", "800"},
        {"drawable-port-xhdpi/splash.png", "720", "1280"},
        {"drawable-port-xxhdpi/splash.png", "960", "1600"},
        {"drawable-port-xxxhdpi/splash.png", "1280", "1920"}
    };

    public static void main(String[] args) throws Exception {
        if (args.length != 3) {
            throw new IllegalArgumentException("Usage: GenerateAndroidIcons <logo image> <android res directory> <web assets directory>");
        }

        BufferedImage source = ImageIO.read(new File(args[0]));
        if (source == null) {
            throw new IllegalArgumentException("Unable to read brand logo: " + args[0]);
        }

        File resources = new File(args[1]);
        File webAssets = new File(args[2]);
        writePng(renderSquare(source, 512), new File(webAssets, "logo-mark.png"));
        writeJpeg(renderSquare(source, 512), new File(webAssets, "logo.jpeg"));
        for (int size : WEB_SIZES) {
            writePng(renderSquare(source, size), new File(webAssets, "safar_kaabe_logo_" + size + "x" + size + ".png"));
        }
        writePng(renderMaskable(source, 512), new File(webAssets, "safar_kaabe_logo_maskable_512x512.png"));

        for (int i = 0; i < DENSITIES.length; i++) {
            File directory = new File(resources, "mipmap-" + DENSITIES[i]);
            if (!directory.isDirectory() && !directory.mkdirs()) {
                throw new IllegalStateException("Unable to create Android resource directory: " + directory);
            }

            BufferedImage icon = renderSquare(source, ICON_SIZES[i]);
            writePng(icon, new File(directory, "ic_launcher.png"));
            writePng(icon, new File(directory, "ic_launcher_round.png"));
            writePng(icon, new File(directory, "ic_launcher_foreground.png"));
        }

        for (String[] asset : SPLASH_ASSETS) {
            File destination = new File(resources, asset[0]);
            writePng(renderSplash(source, Integer.parseInt(asset[1]), Integer.parseInt(asset[2])), destination);
        }
    }

    private static BufferedImage renderSquare(BufferedImage source, int size) {
        BufferedImage image = new BufferedImage(size, size, BufferedImage.TYPE_INT_ARGB);
        Graphics2D graphics = image.createGraphics();
        configure(graphics);
        graphics.setColor(Color.WHITE);
        graphics.fillRect(0, 0, size, size);
        drawContained(graphics, source, size / 2.0, size / 2.0, size, size);
        graphics.dispose();
        return image;
    }

    private static BufferedImage renderSplash(BufferedImage source, int width, int height) {
        BufferedImage image = new BufferedImage(width, height, BufferedImage.TYPE_INT_ARGB);
        Graphics2D graphics = image.createGraphics();
        configure(graphics);
        graphics.setColor(Color.WHITE);
        graphics.fillRect(0, 0, width, height);
        double logoSize = Math.min(width, height) * 0.72;
        drawContained(graphics, source, width / 2.0, height / 2.0, logoSize, logoSize);
        graphics.dispose();
        return image;
    }

    private static BufferedImage renderMaskable(BufferedImage source, int size) {
        BufferedImage image = new BufferedImage(size, size, BufferedImage.TYPE_INT_ARGB);
        Graphics2D graphics = image.createGraphics();
        configure(graphics);
        graphics.setColor(Color.WHITE);
        graphics.fillRect(0, 0, size, size);
        double safeSize = size * 0.92;
        drawContained(graphics, source, size / 2.0, size / 2.0, safeSize, safeSize);
        graphics.dispose();
        return image;
    }

    private static void drawContained(Graphics2D graphics, BufferedImage source, double centerX, double centerY, double maxWidth, double maxHeight) {
        double scale = Math.min(maxWidth / source.getWidth(), maxHeight / source.getHeight());
        int width = (int) Math.round(source.getWidth() * scale);
        int height = (int) Math.round(source.getHeight() * scale);
        int x = (int) Math.round(centerX - width / 2.0);
        int y = (int) Math.round(centerY - height / 2.0);
        graphics.drawImage(source, x, y, width, height, null);
    }

    private static void configure(Graphics2D graphics) {
        graphics.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
        graphics.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BICUBIC);
        graphics.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY);
    }

    private static void writePng(BufferedImage image, File file) throws Exception {
        if (!ImageIO.write(image, "png", file)) {
            throw new IllegalStateException("Unable to write app icon: " + file);
        }
    }

    private static void writeJpeg(BufferedImage image, File file) throws Exception {
        BufferedImage rgb = new BufferedImage(image.getWidth(), image.getHeight(), BufferedImage.TYPE_INT_RGB);
        Graphics2D graphics = rgb.createGraphics();
        graphics.setColor(Color.WHITE);
        graphics.fillRect(0, 0, rgb.getWidth(), rgb.getHeight());
        graphics.drawImage(image, 0, 0, null);
        graphics.dispose();
        if (!ImageIO.write(rgb, "jpg", file)) {
            throw new IllegalStateException("Unable to write JPEG brand logo: " + file);
        }
    }
}
