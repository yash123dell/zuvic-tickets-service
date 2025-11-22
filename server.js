{% comment %}theme-check-disable TemplateLength{% endcomment %}

{{ 'section-main-product.css' | asset_url | stylesheet_tag }}
{{ 'section-main-product-added.css' | asset_url | stylesheet_tag }}
{{ 'component-accordion.css' | asset_url | stylesheet_tag }}
{{ 'component-slider.css' | asset_url | stylesheet_tag }}
{{ 'component-price.css' | asset_url | stylesheet_tag }}
{{ 'component-rte.css' | asset_url | stylesheet_tag }}
{{ 'component-rating.css' | asset_url | stylesheet_tag }}
{{ 'breadcrumb-nav.css' | asset_url | stylesheet_tag }}
{{ 'product-form-input.css' | asset_url | stylesheet_tag }}
{{ 'dynamic-checkout.css' | asset_url | stylesheet_tag }}

<link rel="stylesheet" href="{{ 'component-deferred-media.css' | asset_url }}" media="print" onload="this.media='all'">

<style>
  .product__modal-opener {
    --corner-radius: {{ section.settings.image_card_corner_radius }}px;
    border-radius: var(--corner-radius);
    overflow: hidden;
  }
  .main--product__media--small.media {
    height: 30.4rem;
  }
  .main--product__media--medium.media {
    height: 38.4rem;
  }
  .main--product__media--large.media {
    height: 43.5rem;
  }
  .product__media_container .product__media-list {
    border: 1px solid #ddd;
    border-radius: 10px;
  }

  @media screen and (min-width: 750px) {
    .main--product__media--small.media {
      height: 50rem;
    }
    .main--product__media--medium.media {
      height: 60rem;
    }
    .main--product__media--large.media {
      height: 70rem;
    }
  }
  .section-{{ section.id }}-padding {
    padding-top: {{ section.settings.mobile_padding_top }}px;
    padding-bottom: {{ section.settings.mobile_padding_bottom }}px;
  }

  @media screen and (min-width: 750px) {
    .section-{{ section.id }}-padding {
      padding-top: {{ section.settings.padding_top }}px;
      padding-bottom: {{ section.settings.padding_bottom }}px;
    }
  }
</style>

{%- liquid
  assign current_variant = product.selected_or_first_available_variant

  assign on_sale = false
  if current_variant.compare_at_price != nill
    assign on_sale = true
  endif

  assign productShortDescription = product.metafields.meta.product_excerpt.value
  assign productSizeGuideHandler = product.metafields.meta.product_size_guide.value
  assign productShippingPolicy = product.metafields.meta.product_shipping_policy.value

  assign productCountdown = product.metafields.meta.product_countdown.value
  assign todayDate = 'now' | date: '%s'
  assign countDownDate = productCountdown | date: '%s'

  if section.settings.media_size == 'large'
    assign media_column = 'col-lg-7'
    assign content_column = 'col-lg-5'
    assign media_width = 0.67
  elsif section.settings.media_size == 'medium'
    assign media_column = 'col-lg-6'
    assign content_column = 'col-lg-6'
    assign media_width = 0.50
  else
    assign media_column = 'col-lg-5'
    assign content_column = 'col-lg-7'
    assign media_width = 0.42
  endif
-%}

{%- assign first_3d_model = product.media | where: 'media_type', 'model' | first -%}
{%- if first_3d_model -%}
  {{ 'component-product-model.css' | asset_url | stylesheet_tag }}
  <link
    id="ModelViewerStyle"
    rel="stylesheet"
    href="https://cdn.shopify.com/shopifycloud/model-viewer-ui/assets/v1.0/model-viewer-ui.css"
    media="print"
    onload="this.media='all'"
  >
  <link
    id="ModelViewerOverride"
    rel="stylesheet"
    href="{{ 'component-model-viewer-ui.css' | asset_url }}"
    media="print"
    onload="this.media='all'"
  >
{%- endif -%}

<div
  data-section-id="{{ section.id }}"
  data-section-type="main-product"
  class=" section-{{ section.id }}-padding color-{{ section.settings.color_scheme }} gradient"
>
  <div class="container">
    <div class="product row row-cols-md-2 row-cols-1 product--{{ section.settings.media_size }} product--{{ section.settings.gallery_layout }}">
      <div class="{{ media_column }}">
        <div
          class="product__media_container {% if section.settings.enable_sticky_info %} product__info-container--sticky{% endif %}"
          style="--corner-radius: {{ section.settings.image_card_corner_radius }}px;"
        >
          <a class="skip-to-content-link button visually-hidden" href="#ProductInfo-{{ section.id }}">
            {{ 'accessibility.skip_to_product_info' | t }}
          </a>
          {%- render 'product-page-layout-1',
            product: product,
            media_width: media_width,
            page_width: page_width,
            media_height: section.settings.media_height,
            gallery_layout: gallery_layout,
            hide_variants: hide_variants,
            first_3d_model: first_3d_model
          -%}
        </div>
      </div>
      <div class="{{ content_column }}">
        <div
          id="ProductInfo-{{ section.id }}"
          class="product__info-container {% if section.settings.top_space_enable %} top--space {% endif %} {% if section.settings.enable_sticky_info %} product__info-container--sticky{% endif %}"
        >
          {%- if section.settings.breadcrumb_enable -%}
            <nav role="navigation" aria-label="breadcrumbs" class="breadcrumbs__wrapper">
              <ol class="breadcrumbs__list d-flex">
                <li class="breadcrumbs__item">
                  <a class="breadcrumbs__link" href="/">{{ 'general.back_to_home_label' | t }}</a>
                </li>
                {%- if collection.url -%}
                  <li class="breadcrumbs__item">
                    {{ collection.title | link_to: collection.url }}
                  </li>
                {%- endif -%}
                <li class="breadcrumbs__item">{{ product.title }}</li>
              </ol>
            </nav>
          {%- endif -%}

          {%- assign product_form_id = 'product-form-' | append: section.id -%}

          {%- for block in section.blocks -%}
            {%- case block.type -%}
              {%- when '@app' -%}
                {% render block %}
              {%- when 'additinal_field' -%}
                <div class="cart__additional--field" {{ block.shopify_attributes }}>
                  {%- if block.settings.text_field -%}
                    <div class="input__field_form">
                      <label>
                        <span class="input__field--label"
                          ><b>{{ block.settings.text_field_label }}</b></span
                        >
                        <input
                          class="field__input"
                          type="text"
                          id="engraving"
                          name="properties[Name]"
                          form="{{ product_form_id }}"
                        >
                      </label>
                    </div>
                  {%- endif -%}

                  {%- if block.settings.file_field -%}
                    <div class="input__field_form">
                      <label>
                        <span class="input__field--label"
                          ><b>{{ block.settings.file_field_label }}</b></span
                        >
                        <input type="file" id="file" name="properties[File]" form="{{ product_form_id }}">
                      </label>
                    </div>
                  {%- endif -%}
                </div>
              {%- when 'text' -%}
                <p
                  class="product__text{% if block.settings.text_style == 'uppercase' %} caption-with-letter-spacing{% elsif block.settings.text_style == 'subtitle' %} subtitle{% endif %}"
                  {{ block.shopify_attributes }}
                >
                  {{- block.settings.text -}}
                </p>
              {%- when 'title' -%}
                <h1 class="product__title" {{ block.shopify_attributes }}>
                  {{ product.title | escape }}
                </h1>
              {%- when 'price' -%}
                <div class="price__box_wrapper d-flex" id="price-{{ section.id }}" {{ block.shopify_attributes }}>
                  <div class="no-js-hidden">
                    {%- render 'price',
                      product: product,
                      use_variant: true,
                      show_badges: true,
                      price_class: 'price--large'
                    -%}
                  </div>
                  <div class="save__disoucnt">
                    <span class="discount__sale__text {% if on_sale == false %} no-js-inline {% endif %}">
                      -<span class="sale__save--percent">
                        {{-
                          product.selected_or_first_available_variant.compare_at_price
                          | minus: product.selected_or_first_available_variant.price
                          | times: 100.0
                          | divided_by: product.selected_or_first_available_variant.compare_at_price
                          | money_without_currency
                          | replace: ',', '.'
                          | times: 100
                          | remove: '.0'
                        -}}</span
                      >%</span
                    >
                  </div>
                </div>

                {%- if shop.taxes_included or shop.shipping_policy.body != blank -%}
                  <div class="product__tax caption rte">
                    {%- if shop.taxes_included -%}
                      {{ 'products.product.include_taxes' | t }}
                    {%- endif -%}
                    {%- if shop.shipping_policy.body != blank -%}
                      {{ 'products.product.shipping_policy_html' | t: link: shop.shipping_policy.url }}
                    {%- endif -%}
                  </div>
                {%- endif -%}

                <div {{ block.shopify_attributes }}>
                  {%- form 'product', product, id: 'product-form-installment', class: 'installment caption-large' -%}
                    <input type="hidden" name="id" value="{{ product.selected_or_first_available_variant.id }}">
                    {{ form | payment_terms }}
                  {%- endform -%}
                </div>
              {%- when 'popup_size_guide' -%}
                <div class="product_additional_information" {{ block.shopify_attributes }}>
                  <modal-opener
                    class="product-popup-modal__opener no-js-hidden"
                    data-modal="#PopupModal-1"
                    {{ block.shopify_attributes }}
                  >
                    <button
                      id="ProductPopup-1"
                      class="product-popup-modal__button link"
                      type="button"
                      aria-haspopup="dialog"
                    >
                      {{ block.settings.size_guide }}
                    </button>
                  </modal-opener>
                </div>
              {%- when 'popup_text' -%}
                <div class="product_additional_information" {{ block.shopify_attributes }}>
                  <modal-opener
                    class="product-popup-modal__opener no-js-hidden"
                    data-modal="#PopupModal-2"
                    {{ block.shopify_attributes }}
                  >
                    <button
                      id="ProductPopup-2"
                      class="product-popup-modal__button link"
                      type="button"
                      aria-haspopup="dialog"
                    >
                      {{ block.settings.popup_label }}
                    </button>
                  </modal-opener>
                </div>

              {%- when 'popup_contact_form' -%}
                <div class="product_additional_information" {{ block.shopify_attributes }}>
                  <modal-opener
                    class="product-popup-modal__opener no-js-hidden"
                    data-modal="#PopupModal-3"
                    {{ block.shopify_attributes }}
                  >
                    <button
                      id="ProductPopup-3"
                      class="product-popup-modal__button link"
                      type="button"
                      aria-haspopup="dialog"
                    >
                      {{ block.settings.contact_form_label }}
                    </button>
                  </modal-opener>
                </div>

              {%- when 'description' -%}
                <div class="product__accordion accordion" {{ block.shopify_attributes }}>
                  <details
                    {% if block.settings.always_open %}
                      open
                    {% endif %}
                  >
                    <summary>
                      <div class="summary__title">
                        {% render 'icon-accordion', icon: block.settings.icon %}
                        <h2 class="h4 accordion__title">
                          {{ block.settings.heading }}
                        </h2>
                      </div>
                      {% render 'icon-caret' %}
                    </summary>
                    <div class="accordion__content rte">
                      <!-- Example: Adding Judge.me widget to a product page -->
                      <div class="product-reviews">
                        <!-- Paste your Judge.me widget code here -->
                        {{ '<script type="text/javascript" src="//cdn.judge.me/widget.js"></script>' | raw }}
                      </div>

                      {%- if block.settings.productdesc == 'shortdesc' and productShortDescription != blank -%}
                        <div class="product__description rte">
                          {{ productShortDescription | strip_html }}
                        </div>
                      {%- elsif block.settings.productdesc == 'fulldesc' and product.description != blank -%}
                        {%- assign truncatewords_count = block.settings.truncatewords_count_handle -%}
                        <div class="product__description rte">
                          {{ product.description | truncatewords: truncatewords_count, '' }}
                        </div>
                      {%- endif -%}
                    </div>
                  </details>
                </div>
              {%- when 'inventory' -%}
                {%- liquid
                  if current_variant.inventory_quantity < 0
                    assign progress_bar_width = 0
                  else
                    assign progress_bar_width = current_variant.inventory_quantity | times: 100 | divided_by: 30
                  endif

                  if progress_bar_width > 70
                    assign progress_bar_width = 65
                  endif
                -%}

                <div
                  class="product-variant-inventory"
                  id="inventory__stock--{{ section.id }}"
                  {{ block.shopify_attributes }}
                >
                  <div class="{% if current_variant.inventory_quantity <= 0 and current_variant.inventory_policy == "continue" %}no-js-inline{% endif  %}">
                    <span class="inventory-title {% if current_variant.inventory_quantity <= 1 %} no-js-inline {% endif %}">
                      {{- 'products.product.inventory_status.availability' | t -}}
                    </span>
                    <span class="variant__inventory">
                      <span class="in_stock__title  {% if current_variant.inventory_quantity <= 1 %} no-js-inline {% endif %}">
                        <span class="variant__stock__amount">{{ current_variant.inventory_quantity }}</span>
                        {{ 'products.product.inventory_status.in_stock' | t }}
                      </span>
                      <span class="out__of_stock {% if current_variant.inventory_quantity > 0 %} no-js-inline {% endif %}">
                        {{- 'products.product.inventory_status.out_of_stock' | t -}}
                      </span>
                    </span>

                    <div class="stock_countdown_progress">
                      <span
                        class="stock_progress_bar"
                        style="width: {{ progress_bar_width }}%; --progress-bar-bg: {% if block.settings.gradient_accent_1 != blank %}{{ block.settings.gradient_accent_1 }} {% else %} {{ block.settings.colors_accent_1 }}{% endif %};"
                      ></span>
                    </div>
                  </div>
                </div>
              {%- when 'countdown' -%}
                {%- if todayDate < countDownDate -%}
                  <div class="product__details_countdown">
                    <countdown-timer
                      style="--countdown-foreground: {{ block.settings.timer_foreground }} ; --countdown-background: {{ block.settings.timer_background }}"
                      {{ block.shopify_attributes }}
                    >
                      <span class="countdown__label h6">
                        {%- if block.settings.icon_enable -%}
                          {%- render 'icon-clock', class: 'timer__icon' -%}
                        {%- endif -%}
                        {{ block.settings.countdown_label -}}
                      </span>
                      <div
                        class="product__countdown color-{{ block.settings.color_scheme }}"
                        data-countdown="{{ productCountdown }}"
                      ></div>
                    </countdown-timer>
                  </div>
                {%- endif -%}

              {%- when 'custom_liquid' -%}
                {{ block.settings.custom_liquid }}
              {%- when 'collapsible_tab' -%}
                <div class="product__accordion accordion" {{ block.shopify_attributes }}>
                  <details>
                    <summary>
                      <div class="summary__title">
                        {% render 'icon-accordion', icon: block.settings.icon %}
                        <h2 class="h4 accordion__title">
                          {{ block.settings.heading | default: block.settings.page.title }}
                        </h2>
                      </div>
                      {% render 'icon-caret' %}
                    </summary>
                    <div class="accordion__content rte">
                      {{ block.settings.content }}
                      {{ block.settings.page.content }}
                    </div>
                  </details>
                </div>
              {%- when 'share' -%}
                <div class="social__share_box d-flex align-items-center" {{ block.shopify_attributes }}>
                  {%- render 'social-share', block: block -%}

                  {%- if block.settings.share_link -%}
                    <share-button class="share-button">
                      <button class="share-button__button hidden">
                        {% render 'icon-share' %}
                        {{ block.settings.share_label | escape }}
                      </button>
                      <details>
                        <summary class="share-button__button">
                          {% render 'icon-share' %}
                          {{ block.settings.share_label | escape }}
                        </summary>
                        <div id="Product-share-{{ section.id }}" class="share-button__fallback motion-reduce">
                          <div class="field">
                            <span id="ShareMessage-{{ section.id }}" class="share-button__message hidden" role="status">
                            </span>
                            <input
                              type="text"
                              class="field__input"
                              id="url"
                              value="{{ shop.url | append: product.url }}"
                              placeholder="{{ 'general.share.share_url' | t }}"
                              onclick="this.select();"
                              readonly
                            >
                            <label class="field__label" for="url">{{ 'general.share.share_url' | t }}</label>
                          </div>
                          <button class="share-button__close hidden no-js-hidden">
                            {% render 'icon-close' %}
                            <span class="visually-hidden">{{ 'general.share.close' | t }}</span>
                          </button>
                          <button class="share-button__copy no-js-hidden">
                            {% render 'icon-clipboard' %}
                            <span class="visually-hidden">{{ 'general.share.copy_to_clipboard' | t }}</span>
                          </button>
                        </div>
                      </details>
                    </share-button>
                  {%- endif -%}
                </div>
                <script src="{{ 'share.js' | asset_url }}" defer="defer"></script>
              {%- when 'variant_picker' -%}
                {%- unless product.has_only_default_variant -%}
                  {%- if block.settings.picker_type == 'button' -%}
                    {%- if block.settings.show_color_swatch -%}
                      {%- render 'variant-color-swatch', block: block, product: product -%}
                    {%- else -%}
                      {%- render 'variant-radios', block: block, product: product -%}
                    {%- endif -%}
                  {%- else -%}
                    <variant-selects
                      class="no-js-hidden"
                      data-section="{{ section.id }}"
                      data-origin="{{ request.origin }}"
                      data-url="{{ product.url }}"
                      {{ block.shopify_attributes }}
                    >
                      {%- for option in product.options_with_values -%}
                        <div class="product-form__input product-form__input--dropdown">
                          <label class="form__label" for="Option-{{ section.id }}-{{ forloop.index0 }}">
                            <strong>{{ option.name }}:</strong> <span>{{ option.selected_value }}</span>
                          </label>
                          <div class="select">
                            <select
                              id="Option-{{ section.id }}-{{ forloop.index0 }}"
                              class="select__select"
                              name="options[{{ option.name | escape }}]"
                              form="product-form-{{ section.id }}"
                            >
                              {%- for value in option.values -%}
                                <option
                                  value="{{ value | escape }}"
                                  {% if option.selected_value == value %}
                                    selected="selected"
                                  {% endif %}
                                >
                                  {{ value }}
                                </option>
                              {%- endfor -%}
                            </select>
                            {% render 'icon-caret' %}
                          </div>
                        </div>
                      {%- endfor -%}

                      <script type="application/json" data-variant>
                        {{ product.variants | json }}
                      </script>
                      <script type="application/json" data-preorder>
                        {%- assign firstBrackets = '{'  -%}
                        {%- assign seconrdBrackets = '}'  -%}
                        {{ firstBrackets }}
                        {%- for variant in product.variants -%}
                        "{{variant.id}}": {"qty": {{variant.inventory_quantity}}, "inventory_policy": "{{variant.inventory_policy}}"}{% unless forloop.last == true %},{% endunless %}
                          {%- endfor -%}
                          {{ seconrdBrackets }}
                      </script>
                    </variant-selects>
                  {%- endif -%}
                {%- endunless -%}

                <noscript class="product-form__noscript-wrapper-{{ section.id }}">
                  <div class="product-form__input{% if product.has_only_default_variant %} hidden{% endif %}">
                    <label class="form__label" for="Variants-{{ section.id }}">
                      {{- 'products.product.product_variants' | t -}}
                    </label>
                    <div class="select">
                      <select
                        name="id"
                        id="Variants-{{ section.id }}"
                        class="select__select"
                        form="product-form-{{ section.id }}"
                      >
                        {%- for variant in product.variants -%}
                          <option
                            {% if variant == product.selected_or_first_available_variant %}
                              selected="selected"
                            {% endif %}
                            {% if variant.available == false %}
                              disabled
                            {% endif %}
                            value="{{ variant.id }}"
                          >
                            {{ variant.title }}
                            {%- if variant.available == false %} - {{ 'products.product.sold_out' | t }}{% endif %}
                            - {{ variant.price | money | strip_html }}
                          </option>
                        {%- endfor -%}
                      </select>
                      {% render 'icon-caret' %}
                    </div>
                  </div>
                </noscript>
              {%- when 'buy_buttons' -%}
                <div {{ block.shopify_attributes }}>
                  <product-form class="product-form mb-20 product_buy_button_form">
                    <div class="product-form__error-message-wrapper no-js-inline" role="alert" hidden>
                      <svg
                        aria-hidden="true"
                        focusable="false"
                        role="presentation"
                        class="icon icon-error"
                        viewBox="0 0 13 13"
                      >
                        <circle cx="6.5" cy="6.50049" r="5.5" stroke="white" stroke-width="2"/>
                        <circle cx="6.5" cy="6.5" r="5.5" fill="#EB001B" stroke="#EB001B" stroke-width="0.7"/>
                        <path d="M5.87413 3.52832L5.97439 7.57216H7.02713L7.12739 3.52832H5.87413ZM6.50076 9.66091C6.88091 9.66091 7.18169 9.37267 7.18169 9.00504C7.18169 8.63742 6.88091 8.34917 6.50076 8.34917C6.12061 8.34917 5.81982 8.63742 5.81982 9.00504C5.81982 9.37267 6.12061 9.66091 6.50076 9.66091Z" fill="white"/>
                        <path d="M5.87413 3.17832H5.51535L5.52424 3.537L5.6245 7.58083L5.63296 7.92216H5.97439H7.02713H7.36856L7.37702 7.58083L7.47728 3.537L7.48617 3.17832H7.12739H5.87413ZM6.50076 10.0109C7.06121 10.0109 7.5317 9.57872 7.5317 9.00504C7.5317 8.43137 7.06121 7.99918 6.50076 7.99918C5.94031 7.99918 5.46982 8.43137 5.46982 9.00504C5.46982 9.57872 5.94031 10.0109 6.50076 10.0109Z" fill="white" stroke="#EB001B" stroke-width="0.7">
                      </svg>
                      <span class="product-form__error-message"></span>
                    </div>

                    {%- form 'product',
                      product,
                      id: product_form_id,
                      class: 'form',
                      novalidate: 'novalidate',
                      data-type: 'add-to-cart-form'
                    -%}
                      <input type="hidden" name="id" value="{{ product.selected_or_first_available_variant.id }}">
                      <div class="product-form__buttons">
                        <div class="product-form__cart--box d-flex align-items-end">
                          {%- if block.settings.quantity__button -%}
                            <div class="product-form__input product-form__quantity">
                              <label class="form__label" for="Quantity-{{ section.id }}">
                                <strong>{{ 'products.product.quantity.label' | t }}</strong>
                              </label>

                              <quantity-input class="quantity">
                                <button class="quantity__button no-js-hidden" name="minus" type="button">
                                  <span class="visually-hidden">
                                    {{- 'products.product.quantity.decrease' | t: product: product.title | escape -}}
                                  </span>
                                  {% render 'icon-minus' %}
                                </button>
                                <input
                                  class="quantity__input"
                                  type="number"
                                  name="quantity"
                                  id="Quantity-{{ section.id }}"
                                  min="1"
                                  value="1"
                                  form="product-form-{{ section.id }}"
                                >
                                <button class="quantity__button no-js-hidden" name="plus" type="button">
                                  <span class="visually-hidden">
                                    {{- 'products.product.quantity.increase' | t: product: product.title | escape -}}
                                  </span>
                                  {% render 'icon-plus' %}
                                </button>
                              </quantity-input>
                            </div>
                          {%- endif -%}

                          <div class="product__add__cart__button">
                            <button
                              type="submit"
                              name="add"
                              class="product-form__submit button {% if block.settings.show_dynamic_checkout and product.selling_plan_groups == empty %} button--{{ block.settings.add_to_cart__button }}{% else %}button--primary{% endif %}"
                              {% if product.selected_or_first_available_variant.available == false %}
                                disabled
                              {% endif %}
                            >
                              {%- if current_variant.available -%}
                                {%- if current_variant.inventory_quantity <= 0
                                  and current_variant.inventory_policy == 'continue'
                                -%}
                                  {{ 'products.product.preorder' | t }}
                                {%- else -%}
                                  {{ 'products.product.add_to_cart' | t }}
                                {%- endif -%}
                              {%- else -%}
                                {{ 'products.product.sold_out' | t }}
                              {%- endif -%}
                            </button>
                          </div>
                        </div>

                        {%- if block.settings.show_dynamic_checkout -%}
                          {{ form | payment_button }}
                        {%- endif -%}
                      </div>
                    {%- endform -%}
                  </product-form>

                  <modal-opener
                    class="product-popup-modal__opener notify__me--available mb-30 {% if current_variant.available == true %}no-js-inline{% endif %}"
                    data-modal="#PopupModal-4"
                    {{ block.shopify_attributes }}
                  >
                    <button
                      id="ProductPopup-notify"
                      class="product-popup-modal__button link"
                      type="button"
                      aria-haspopup="dialog"
                    >
                      {{ 'products.product.back_in_stock_notify.button' | t }}
                    </button>
                  </modal-opener>

                  {%- if block.settings.guarantee_safe_checkout -%}
                    <div class="guarantee__safe__checkout">
                      <p>{{ block.settings.safe_checkout_text }}</p>
                      <ul class="list d-flex product__payment mb-20" role="list">
                        {%- for type in shop.enabled_payment_types -%}
                          <li class="product__payment__item">
                            {{ type | payment_type_svg_tag: class: 'icon icon--full-color' }}
                          </li>
                        {%- endfor -%}
                      </ul>
                    </div>
                  {%- endif -%}

                  {{ 'component-pickup-availability.css' | asset_url | stylesheet_tag }}

                  {%- assign pick_up_availabilities = product.selected_or_first_available_variant.store_availabilities
                    | where: 'pick_up_enabled', true
                  -%}

                  <pickup-availability
                    class="product__pickup-availabilities no-js-hidden"
                    {% if product.selected_or_first_available_variant.available and pick_up_availabilities.size > 0 %}
                      available
                    {% endif %}
                    data-root-url="{{ routes.root_url }}"
                    data-variant-id="{{ product.selected_or_first_available_variant.id }}"
                    data-has-only-default-variant="{{ product.has_only_default_variant }}"
                  >
                    <template>
                      <pickup-availability-preview class="pickup-availability-preview">
                        {% render 'icon-unavailable' %}
                        <div class="pickup-availability-info">
                          <p class="caption-large">{{ 'products.product.pickup_availability.unavailable' | t }}</p>
                          <button class="pickup-availability-button link link--text underlined-link">
                            {{ 'products.product.pickup_availability.refresh' | t }}
                          </button>
                        </div>
                      </pickup-availability-preview>
                    </template>
                  </pickup-availability>
                </div>

                <script src="{{ 'pickup-availability.js' | asset_url }}" defer="defer"></script>

              {%- when 'barcode' -%}
                <div id="barcode__{{ section.id }}" {{ block.shopify_attributes }}>
                  <div class="product__variant_barcode {% if current_variant.barcode == blank %} no-js-inline {% endif %}">
                    <strong>{{ 'products.product.barcode' | t }}:</strong>
                    <span class="barcode__unique_code">{{ current_variant.barcode }}</span>
                  </div>
                </div>
              {%- when 'sku' -%}
                <div id="sku__{{ section.id }}" {{ block.shopify_attributes }}>
                  <div class="product__variant_sku {% if current_variant.sku == blank %} no-js-inline {% endif %}">
                    <strong>{{ 'products.product.sku' | t }}:</strong>
                    <span class="sku__unique_code">{{ current_variant.sku }}</span>
                  </div>
                </div>
              {%- when 'vendor' -%}
                {%- if product.vendor != blank -%}
                  <div class="product__vendor" {{ block.shopify_attributes }}>
                    <strong>{{ 'products.product.vendor' | t }}:</strong> {{ product.vendor }}
                  </div>
                {%- endif -%}
              {%- when 'type' -%}
                {%- if product.type != blank -%}
                  <div class="product__type" {{ block.shopify_attributes }}>
                    <strong>{{ 'products.product.type' | t }}:</strong> {{ product.type }}
                  </div>
                {%- endif -%}

              {%- when 'rating' -%}
                {%- if product.metafields.reviews.rating.value != blank -%}
                  {% liquid
                    assign rating_decimal = 0
                    assign decimal = product.metafields.reviews.rating.value.rating | modulo: 1
                    if decimal >= 0.3 and decimal <= 0.7
                      assign rating_decimal = 0.5
                    elsif decimal > 0.7
                      assign rating_decimal = 1
                    endif
                  %}
                  <div
                    class="rating"
                    role="img"
                    aria-label="{{ 'accessibility.star_reviews_info' | t: rating_value: product.metafields.reviews.rating.value, rating_max: product.metafields.reviews.rating.value.scale_max }}"
                  >
                    <span
                      aria-hidden="true"
                      class="rating-star color-icon-{{ settings.accent_icons }}"
                      style="--rating: {{ product.metafields.reviews.rating.value.rating | floor }}; --rating-max: {{ product.metafields.reviews.rating.value.scale_max }}; --rating-decimal: {{ rating_decimal }};"
                    ></span>
                  </div>
                  <p class="rating-text caption">
                    <span aria-hidden="true">
                      {{- product.metafields.reviews.rating.value }} /
                      {{ product.metafields.reviews.rating.value.scale_max -}}
                    </span>
                  </p>
                  <p class="rating-count caption">
                    <span aria-hidden="true">({{ product.metafields.reviews.rating_count }})</span>
                    <span class="visually-hidden">
                      {{- product.metafields.reviews.rating_count }}
                      {{ 'accessibility.total_reviews' | t -}}
                    </span>
                  </p>
                {%- endif -%}
            {%- endcase -%}
          {%- endfor -%}
        </div>
      </div>
    </div>

    <product-modal id="ProductModal-{{ section.id }}" class="product-media-modal media-modal">
      <div
        class="product-media-modal__dialog"
        role="dialog"
        aria-label="{{ 'products.modal.label' | t }}"
        aria-modal="true"
        tabindex="-1"
      >
        <button
          id="ModalClose-{{ section.id }}"
          type="button"
          class="product-media-modal__toggle"
          aria-label="{{ 'accessibility.close' | t }}"
        >
          {% render 'icon-close' %}
        </button>

        <div
          class="product-media-modal__content"
          role="document"
          aria-label="{{ 'products.modal.label' | t }}"
          tabindex="0"
        >
          {%- liquid
            if product.selected_or_first_available_variant.featured_media != null
              assign media = product.selected_or_first_available_variant.featured_media
              render 'product-media', media: media, loop: section.settings.enable_video_looping, variant_image: section.settings.hide_variants
            endif
          -%}

          {%- for media in product.media -%}
            {%- liquid
              if section.settings.hide_variants and variant_images contains media.src
                assign variant_image = true
              else
                assign variant_image = false
              endif

              unless media.id == product.selected_or_first_available_variant.featured_media.id
                render 'product-media', media: media, loop: section.settings.enable_video_looping, variant_image: variant_image
              endunless
            -%}
          {%- endfor -%}
        </div>
      </div>
    </product-modal>

    {% assign popups = section.blocks | where: 'type', 'popup_size_guide' %}
    {%- for block in popups -%}
      {% liquid
        assign sizepagehandle = pages[block.settings.sizeguidhandle].content
      %}
      {%- if productSizeGuideHandler != blank -%}
        <modal-dialog id="PopupModal-1" class="product-popup-modal" {{ block.shopify_attributes }}>
          <div
            role="dialog"
            aria-label="{{ block.settings.text }}"
            aria-modal="true"
            class="product-popup-modal__content"
            tabindex="-1"
          >
            <div class="modal-header">
              <h5 class="modal__title">{{ block.settings.size_guide }}</h5>
              <button
                id="ModalClose-1"
                type="button"
                class="product-popup-modal__toggle"
                aria-label="{{ 'accessibility.close' | t }}"
              >
                {% render 'icon-close' %}
              </button>
            </div>
            <div class="product-popup-modal__content-info pt-25">
              {%- if product.metafields.meta.product_size_guide.type == 'file_reference' -%}
                <img src="{{ productSizeGuideHandler | img_url: "master" }}" alt="{{ "Product Size Guide" }}">
              {%- else -%}
                {{ productSizeGuideHandler }}
              {%- endif -%}
            </div>
          </div>
        </modal-dialog>
      {%- else -%}
        <modal-dialog id="PopupModal-1" class="product-popup-modal" {{ block.shopify_attributes }}>
          <div
            role="dialog"
            aria-label="{{ block.settings.text }}"
            aria-modal="true"
            class="product-popup-modal__content"
            tabindex="-1"
          >
            <div class="modal-header">
              <h5 class="modal__title">{{ block.settings.size_guide }}</h5>
              <button
                id="ModalClose-1"
                type="button"
                class="product-popup-modal__toggle"
                aria-label="{{ 'accessibility.close' | t }}"
              >
                {% render 'icon-close' %}
              </button>
            </div>
            <div class="product-popup-modal__content-info pt-25 rte">
              {%- if sizepagehandle != empty or block.settings.content != blank -%}
                {{ block.settings.content }}
                {{ sizepagehandle }}
              {%- else -%}
                Please select a page or Add metafield
              {%- endif -%}
            </div>
          </div>
        </modal-dialog>
      {%- endif -%}
    {%- endfor -%}

    {% assign popup_text = section.blocks | where: 'type', 'popup_text' %}
    {%- for block in popup_text -%}
      {% liquid
        assign shippinghandle = pages[block.settings.shipping_page_handle].content
      %}
      {%- if productShippingPolicy != blank -%}
        <modal-dialog id="PopupModal-2" class="product-popup-modal modal-md" {{ block.shopify_attributes }}>
          <div
            role="dialog"
            aria-label="{{ block.settings.text }}"
            aria-modal="true"
            class="product-popup-modal__content modal-md"
            tabindex="-1"
          >
            <div class="modal-header">
              <h5 class="modal__title">{{ block.settings.popup_label }}</h5>
              <button
                id="ModalClose-2"
                type="button"
                class="product-popup-modal__toggle"
                aria-label="{{ 'accessibility.close' | t }}"
              >
                {% render 'icon-close' %}
              </button>
            </div>
            <div class="product-popup-modal__content-info pt-25">
              {%- if product.metafields.meta.product_shipping_policy.type == 'file_reference' -%}
                <img src="{{ productShippingPolicy | img_url: "master" }}" alt="{{ "Product Shipping Policy" }}">
              {%- else -%}
                {{ productShippingPolicy }}
              {%- endif -%}
            </div>
          </div>
        </modal-dialog>
      {%- else -%}
        <modal-dialog id="PopupModal-2" class="product-popup-modal" {{ block.shopify_attributes }}>
          <div
            role="dialog"
            aria-label="{{ block.settings.text }}"
            aria-modal="true"
            class="product-popup-modal__content modal-md"
            tabindex="-1"
          >
            <div class="modal-header">
              <h5 class="modal__title">{{ block.settings.popup_label }}</h5>
              <button
                id="ModalClose-2"
                type="button"
                class="product-popup-modal__toggle"
                aria-label="{{ 'accessibility.close' | t }}"
              >
                {% render 'icon-close' %}
              </button>
            </div>
            <div class="product-popup-modal__content-info pt-25 rte">
              {%- if shippinghandle != empty or block.settings.content != blank -%}
                {{ block.settings.content }}
                {{ shippinghandle }}
              {%- else -%}
                Please select a page
              {%- endif -%}
            </div>
          </div>
        </modal-dialog>
      {%- endif -%}
    {%- endfor -%}

    {% assign popup_form = section.blocks | where: 'type', 'popup_contact_form' %}
    {%- for block in popup_form -%}
      {%- liquid

      -%}
      <modal-dialog id="PopupModal-3" class="product-popup-modal popup__contact--form" {{ block.shopify_attributes }}>
        <div
          role="dialog"
          aria-label="{{ block.settings.text }}"
          aria-modal="true"
          class="product-popup-modal__content modal-sm"
          tabindex="-1"
        >
          <div class="modal-header">
            <h5 class="modal__title">{{ block.settings.ask_about_prod_title }}</h5>
            <button
              id="ModalClose-3"
              type="button"
              class="product-popup-modal__toggle"
              aria-label="{{ 'accessibility.close' | t }}"
            >
              {% render 'icon-close' %}
            </button>
          </div>

          <div class="product-popup-modal__content-info pt-25">
            {% form 'contact', class: 'ask_about_product' %}
              <div class="row">
                <div class="col-12">
                  {% if form.posted_successfully? %}
                    <p class="note form-success">{{ 'contact.form.post_success' | t }}</p>
                  {% endif %}
                  {{ form.errors | default_errors }}
                </div>
                <div class="col-md-6 mb-30">
                  <label class="visually-hidden" for="PopupContactFormName">
                    {{- block.settings.name_placeholder -}}
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="{{ block.settings.name_placeholder }}"
                    class="{% if form.errors contains 'name' %}error{% endif %}"
                    name="contact[name]"
                    id="PopupContactFormName"
                    value="{% if form.name %}{{ form.name }}{% elsif customer.name %}{{ customer.name }}{% endif %}"
                  >
                </div>
                <div class="col-md-6 mb-30">
                  <label class="visually-hidden" for="PopupContactFormEmail">
                    {{- block.settings.email_placeholder -}}
                  </label>
                  <input
                    type="email"
                    required
                    placeholder="{{ block.settings.email_placeholder }}"
                    class="{% if form.errors contains 'email' %}error{% endif %}"
                    name="contact[email]"
                    id="PopupContactFormEmail"
                    value="{% if form.email %}{{ form.email }}{% elsif customer.email %}{{ customer.email }}{% endif %}"
                  >
                </div>
                <div class="col-lg-12 mb-30">
                  <label class="visually-hidden" for="PopupContactPhone">{{ block.settings.phone_placeholder }}</label>
                  <input
                    type="text"
                    name="contact[phone]"
                    placeholder="{{ block.settings.phone_placeholder }}"
                    id="PopupContactPhone"
                    value="{{ form.phone }}"
                  >
                </div>
                <div class="col-lg-12 mb-30">
                  <label class="visually-hidden" for="PopupCoPopupContactUrlntactUrl">
                    {{- block.settings.prod_url_placeholder -}}
                  </label>
                  <input
                    type="text"
                    required
                    name="contact[productURL]"
                    placeholder="{{ block.settings.prod_url_placeholder }}"
                    id="PopupContactUrl"
                    value="{{ shop.url | append: product.url }}"
                  >
                </div>
                <div class="col-lg-12 mb-30">
                  <label class="visually-hidden" for="PopupContactFormMessage">
                    {{- block.settings.body_placeholder -}}
                  </label>
                  <textarea
                    placeholder="{{ block.settings.body_placeholder }}"
                    class="custom-textarea"
                    name="contact[body]"
                    id="PopupContactFormMessage"
                  >{% if form.body %}{{ form.body }}{% endif %}</textarea>
                </div>
                <div class="col-lg-12 text-center">
                  <button type="submit" value="submit" class="button">{{ block.settings.send_btn_text }}</button>
                </div>
              </div>
            {% endform %}
          </div>
        </div>
      </modal-dialog>
    {%- endfor -%}

    <modal-dialog id="PopupModal-4" class="product-popup-modal back__in--stock-popup" {{ block.shopify_attributes }}>
      <div
        role="dialog"
        aria-label="{{ block.settings.text }}"
        aria-modal="true"
        class="product-popup-modal__content modal-sm"
        tabindex="-1"
      >
        <div class="modal-header">
          <h5 class="modal__title">{{ 'products.product.back_in_stock_notify.Popup_heading' | t }}</h5>
          <button
            id="ModalClose-4"
            type="button"
            class="product-popup-modal__toggle"
            aria-label="{{ 'accessibility.close' | t }}"
          >
            {% render 'icon-close' %}
          </button>
        </div>

        <div class="product-popup-modal__content-info pt-25">
          {% form 'contact', class: 'ask_about_product' %}
            <div class="row">
              <div class="col-12">
                {% if form.posted_successfully? %}
                  <p class="note form-success">{{ 'Email has been sucessfully sent' }}</p>
                {% endif %}
                {{ form.errors | default_errors }}
              </div>

              <div class="col-md-12 mb-30">
                <input
                  type="email"
                  class="w-100"
                  required
                  placeholder="{{ "products.product.back_in_stock_notify.email_placeholder" | t }}"
                  class="{% if form.errors contains 'email' %}error{% endif %}"
                  name="contact[email]"
                  id="ContactFormEmail"
                  value="{% if form.email %}{{ form.email }}{% elsif customer.email %}{{ customer.email }}{% endif %}"
                >
              </div>

              <div class="d-none">
                <textarea
                  class="custom-textarea"
                  name="contact[message]"
                > {{ "products.product.back_in_stock_notify.Email_Body_First_Title" | t }} {{ product.title }} {{ "products.product.back_in_stock_notify.Email_Body_Last_Title" | t }} </textarea>
              </div>

              <div class="d-none">
                <textarea
                  class="soldout__product_url"
                  name="contact[ProductURL]"
                > {{ shop.url | append: product.url | append: "?variant=" | append: current_variant.id }}</textarea>
              </div>

              <div class="col-lg-12 text-center">
                <button type="submit" value="submit" class="button">
                  {{ 'products.product.back_in_stock_notify.submit' | t }}
                </button>
              </div>
            </div>
          {% endform %}
        </div>
      </div>
    </modal-dialog>

    {%- if section.settings.sticky_enable -%}
      {%- render 'product-sticky-add-cart', current_variant: current_variant -%}
    {%- endif -%}
  </div>
</div>

<script src="{{ 'product-modal.js' | asset_url }}" defer="defer"></script>
<script>
  document.addEventListener('DOMContentLoaded', function() {
    function isIE() {
      const ua = window.navigator.userAgent;
      const msie = ua.indexOf('MSIE ');
      const trident = ua.indexOf('Trident/');

      return (msie > 0 || trident > 0);
    }

    if (!isIE()) return;
    const hiddenInput = document.querySelector('#{{ product_form_id }} input[name="id"]');
    const noScriptInputWrapper = document.createElement('div');
    const variantSwitcher = document.querySelector('variant-radios[data-section="{{ section.id }}"]') || document.querySelector('variant-selects[data-section="{{ section.id }}"]');
    noScriptInputWrapper.innerHTML = document.querySelector('.product-form__noscript-wrapper-{{ section.id }}').textContent;
    variantSwitcher.outerHTML = noScriptInputWrapper.outerHTML;

    document.querySelector('#Variants-{{ section.id }}').addEventListener('change', function(event) {
      hiddenInput.value = event.currentTarget.value;
    });
  });
</script>

<script src="{{ 'custom-slider.js' | asset_url }}" defer></script>
{%- if product.media.size > 0 -%}
  <script src="{{ 'media-gallery.js' | asset_url }}" defer="defer"></script>
{%- endif -%}

{%- if first_3d_model -%}
  <script type="application/json" id="ProductJSON-{{ product.id }}">
    {{ product.media | where: 'media_type', 'model' | json }}
  </script>

  <script src="{{ 'product-model.js' | asset_url }}" defer></script>
{%- endif -%}

<script type="application/ld+json">
  {
    "@context": "http://schema.org/",
    "@type": "Product",
    "name": {{ product.title | json }},
    "url": {{ shop.url | append: product.url | json }},
    {%- if product.selected_or_first_available_variant.featured_media -%}
      {%- assign media_size = product.selected_or_first_available_variant.featured_media.preview_image.width | append: 'x' -%}
      "image": [
        {{ product.selected_or_first_available_variant.featured_media | img_url: media_size | prepend: "https:" | json }}
      ],
    {%- endif -%}
    "description": {{ product.description | strip_html | json }},
    {%- if product.selected_or_first_available_variant.sku != blank -%}
      "sku": {{ product.selected_or_first_available_variant.sku | json }},
    {%- endif -%}
    "brand": {
      "@type": "Thing",
      "name": {{ product.vendor | json }}
    },
    "offers": [
      {%- for variant in product.variants -%}
        {
          "@type" : "Offer",
          {%- if variant.sku != blank -%}
            "sku": {{ variant.sku | json }},
          {%- endif -%}
          "availability" : "http://schema.org/{% if variant.available %}InStock{% else %}OutOfStock{% endif %}",
          "price" : {{ variant.price | divided_by: 100.00 | json }},
          "priceCurrency" : {{ cart.currency.iso_code | json }},
          "url" : {{ shop.url | append: variant.url | json }}
        }{% unless forloop.last %},{% endunless %}
      {%- endfor -%}
    ]
  }
</script>

{% schema %}
{
  "name": "t:sections.main-product.name",
  "tag": "section",
  "class": "product-section spaced-section",
  "settings": [
    {
      "type": "color_scheme",
      "id": "color_scheme",
      "label": "t:sections.all.colors.label",
      "default": "background-1"
    },
  	 {
      "type": "header",
      "content": "Breadcrumbs"
    },
  	{
      "type": "checkbox",
      "id": "breadcrumb_enable",
      "default": true,
      "label": "Show breadcrumbs"
    },
  	 {
      "type": "header",
      "content": "t:sections.main-product.settings.header.content",
      "info": "t:sections.main-product.settings.header.info"
    },
    {
      "type": "select",
      "id": "gallery_layout",
      "label": "Desktop layout",
      "default": "thumbnail_slider",
      "options": [
          {
            "value": "stacked",
            "label": "Stacked"
          },
          {
              "value": "thumbnail",
              "label": "Thumbnails"
          },
  		  {
              "value": "thumbnail_slider",
              "label": "Thumbnails carousel"
          }
      ]
    },
  	{
      "type": "select",
      "id": "media_size",
      "label": "Media size",
      "default": "large",
  	  "info": "Media is automatically optimized for mobile",
      "options": [
          {
            "value": "large",
            "label": "Large"
          },
          {
              "value": "medium",
              "label": "Medium"
          },
  		  {
              "value": "small",
              "label": "Small"
          }
      ]
    },
  	{
      "type": "select",
      "id": "media_height",
      "label": "Image height",
      "default": "adapt",
      "options": [
  		  {
            "value": "adapt",
            "label": "Adapt to image"
          },
          {
            "value": "large",
            "label": "Large"
          },
          {
              "value": "medium",
              "label": "Medium"
          },
  		  {
              "value": "small",
              "label": "Small"
          }
      ]
    },
  	{
      "type": "select",
      "id": "mobile_thumbnails",
      "options": [
        {
          "value": "show",
          "label": "Show thumbnails"
        },
        {
          "value": "hide",
          "label": "Hide thumbnails"
        }
      ],
      "default": "show",
      "label": "Mobile layout"
    },
    {
      "type": "range",
      "id": "image_card_corner_radius",
      "min": 0,
      "max": 32,
      "step": 1,
      "unit": "px",
      "label": "Card corner radius",
      "default": 10
    },
  	{
      "type": "checkbox",
      "id": "hide_variants",
      "default": false,
      "label": "Hide other variants’ media after selecting a variant"
    },
  	{
      "type": "checkbox",
      "id": "enable_sticky_info",
      "default": true,
      "label": "t:sections.main-product.settings.enable_sticky_info.label"
    },
    {
  	 "type": "header",
      "content": "Product information"
    },
  	{
      "type": "checkbox",
      "id": "top_space_enable",
      "default": true,
      "label": "Desktop top space"
    },
    {
      "type": "header",
      "content": "Sticky cart"
    },
    {
      "type": "checkbox",
      "id": "sticky_enable",
      "default": true,
      "label": "Enable"
    },
  	{
          "type": "header",
          "content": "Section padding"
        },
		{
          "type": "paragraph",
          "content": "Desktop"
        },
        {
          "type": "range",
          "id": "padding_top",
          "min": 0,
          "max": 150,
          "step": 5,
          "unit": "px",
          "label": "Padding top",
          "default": 0
        },
        {
          "type": "range",
          "id": "padding_bottom",
          "min": 0,
          "max": 150,
          "step": 5,
          "unit": "px",
          "label": "Padding bottom",
          "default": 0
        },
		{
          "type": "paragraph",
          "content": "Mobile"
        },
		{
          "type": "range",
          "id": "mobile_padding_top",
          "min": 0,
          "max": 150,
          "step": 5,
          "unit": "px",
          "label": "Padding top",
          "default": 0
        },
        {
          "type": "range",
          "id": "mobile_padding_bottom",
          "min": 0,
          "max": 150,
          "step": 5,
          "unit": "px",
          "label": "Padding bottom",
          "default": 0
        }
  ],
  "blocks": [
    {
      "type": "@app"
    },
    {
      "type": "text",
      "name": "t:sections.main-product.blocks.text.name",
      "settings": [
        {
          "type": "text",
          "id": "text",
          "default": "Text block",
          "label": "t:sections.main-product.blocks.text.settings.text.label"
        },
        {
          "type": "select",
          "id": "text_style",
          "options": [
            {
              "value": "body",
              "label": "t:sections.main-product.blocks.text.settings.text_style.options__1.label"
            },
            {
              "value": "subtitle",
              "label": "t:sections.main-product.blocks.text.settings.text_style.options__2.label"
            },
            {
              "value": "uppercase",
              "label": "t:sections.main-product.blocks.text.settings.text_style.options__3.label"
            }
          ],
          "default": "body",
          "label": "t:sections.main-product.blocks.text.settings.text_style.label"
        }
      ]
    },
    {
      "type": "title",
      "name": "t:sections.main-product.blocks.title.name",
      "limit": 1
    },
    {
      "type": "price",
      "name": "t:sections.main-product.blocks.price.name",
      "limit": 1
    },
  	{
      "type": "countdown",
      "name": "Countdown timer",
      "limit": 1,
  	  "settings": [
  		  {
              "type": "text",
              "id": "countdown_label",
              "default": "Hurry up! Sale ends in",
              "label": "Heading"
          },
  		  {
            "type": "checkbox",
            "id": "icon_enable",
            "default": true,
            "label": "Show icon"
          },
  		  {
            "type": "color",
            "id": "timer_background",
            "default": "#121212",
            "label": "Background color"
          },
  		  {
            "type": "color",
            "id": "timer_foreground",
            "default": "#fff",
            "label": "Text color"
          },
          {
            "type": "header",
            "content": "Countdown",
            "info": "Follow the instructions on how to add a countdown timer to a product. [click here](https://themeadora.com/doc/product-countdown/)"
          }
  		]
    },
  	{
      "type": "inventory",
      "name": "Inventory status",
      "limit": 1,
  	  "settings": [
  		  {
            "type": "color",
            "id": "colors_accent_1",
            "default": "#121212",
            "label": "Background color"
          },
          {
            "id": "gradient_accent_1",
            "type": "color_background",
            "label": "Background gradient color"
          }
  		]
    },
  	{
      "type": "vendor",
      "name": "Vendor",
      "limit": 1
    },
  	{
      "type": "additinal_field",
      "name": "Additional field",
      "limit": 1,
  	  "settings": [
        {
        "type": "checkbox",
        "id": "text_field",
        "default": true,
        "label": "Show text field"
        },
  		{
          "type": "text",
          "id": "text_field_label",
          "default": "Enter your name",
          "label": "Text label"
        },
  		{
        "type": "checkbox",
        "id": "file_field",
        "default": true,
        "label": "Show file field"
        },
        {
          "type": "text",
          "id": "file_field_label",
          "default": "Add your image",
          "label": "File label"
        }
  	  ]
    },
  	{
      "type": "type",
      "name": "Type",
      "limit": 1
    },
  	{
      "type": "sku",
      "name": "Sku",
      "limit": 1
    },
  	{
      "type": "barcode",
      "name": "Barcode",
      "limit": 1
    },
    {
      "type": "variant_picker",
      "name": "t:sections.main-product.blocks.variant_picker.name",
      "limit": 1,
      "settings": [
        {
          "type": "select",
          "id": "picker_type",
          "options": [
            {
              "value": "dropdown",
              "label": "t:sections.main-product.blocks.variant_picker.settings.picker_type.options__1.label"
            },
            {
              "value": "button",
              "label": "t:sections.main-product.blocks.variant_picker.settings.picker_type.options__2.label"
            }
          ],
          "default": "button",
          "label": "t:sections.main-product.blocks.variant_picker.settings.picker_type.label"
        },
  		{
          "type": "header",
          "content": "COLOR SWATCHES",
  		  "info": "Required! The variant picker type must be 'Button'"
        },
  		{
          "type": "checkbox",
          "id": "show_color_swatch",
          "default": true,
          "label": "Enable color swatches"
        },
  		{
          "type": "select",
          "id": "color_option_style",
          "options": [
            {
              "value": "image",
              "label": "Variant image"
            },
  			{
              "value": "color",
              "label": "Color swatch"
            }
          ],
          "default": "color",
          "label": "Swatch type"
        },
  		{
          "type": "text",
          "id": "choose_options_name",
          "default": "Color",
          "label": "Option name",
  		  "info": "To show the image on variant"
        },
  		{
          "type": "select",
          "id": "color_option_design",
          "options": [
            {
              "value": "round",
              "label": "Round"
            },
  			{
              "value": "square",
              "label": "Square"
            }
          ],
          "default": "round",
          "label": "Color option style"
        }
      ]
    },
    {
      "type": "buy_buttons",
      "name": "t:sections.main-product.blocks.buy_buttons.name",
      "limit": 1,
      "settings": [
  		{
          "type": "checkbox",
          "id": "quantity__button",
          "default": true,
          "label": "Show quantity button"
        },
        {
          "type": "select",
          "id": "add_to_cart__button",
          "label": "Cart button type",
          "default": "secondary",
          "options": [
            {
              "value": "primary",
              "label": "Primary"
            },
            {
              "value": "secondary",
              "label": "Secondary"
            }
          ]
        },
        {
          "type": "checkbox",
          "id": "show_dynamic_checkout",
          "default": true,
          "label": "t:sections.main-product.blocks.buy_buttons.settings.show_dynamic_checkout.label",
          "info": "t:sections.main-product.blocks.buy_buttons.settings.show_dynamic_checkout.info"
        },
  		{
        	"type": "header",
        	"content": "guarantee safe checkout"
        },
  		{
          "type": "checkbox",
          "id": "guarantee_safe_checkout",
          "default": false,
          "label": "Show trust badge"
        },
        {
          "type": "text",
          "id": "safe_checkout_text",
          "default": "Guaranteed safe checkout",
          "label": "Trust badge text"
        }
      ]
    },
    {
      "type": "description",
      "name": "t:sections.main-product.blocks.description.name",
      "limit": 1,
	  "settings": [
        {
          "type": "text",
          "id": "heading",
          "default": "Description",
          "label": "t:sections.main-product.blocks.collapsible_tab.settings.heading.label"
        },
        {
          "type": "checkbox",
          "id": "always_open",
          "default": false,
          "label": "Always show description"
        },
        {
          "type": "select",
          "id": "icon",
          "options": [
            {
              "value": "none",
              "label": "t:sections.main-product.blocks.collapsible_tab.settings.icon.options__1.label"
            },
            {
              "value": "box",
              "label": "t:sections.main-product.blocks.collapsible_tab.settings.icon.options__2.label"
            },
            {
              "value": "chat_bubble",
              "label": "t:sections.main-product.blocks.collapsible_tab.settings.icon.options__3.label"
            },
            {
              "value": "check_mark",
              "label": "t:sections.main-product.blocks.collapsible_tab.settings.icon.options__4.label"
            },
            {
              "value": "dryer",
              "label": "t:sections.main-product.blocks.collapsible_tab.settings.icon.options__5.label"
            },
            {
              "value": "eye",
              "label": "t:sections.main-product.blocks.collapsible_tab.settings.icon.options__6.label"
            },
            {
              "value": "heart",
              "label": "t:sections.main-product.blocks.collapsible_tab.settings.icon.options__7.label"
            },
            {
              "value": "iron",
              "label": "t:sections.main-product.blocks.collapsible_tab.settings.icon.options__8.label"
            },
            {
              "value": "leaf",
              "label": "t:sections.main-product.blocks.collapsible_tab.settings.icon.options__9.label"
            },
            {
              "value": "leather",
              "label": "t:sections.main-product.blocks.collapsible_tab.settings.icon.options__10.label"
            },
            {
              "value": "lock",
              "label": "t:sections.main-product.blocks.collapsible_tab.settings.icon.options__11.label"
            },
            {
              "value": "map_pin",
              "label": "t:sections.main-product.blocks.collapsible_tab.settings.icon.options__12.label"
            },
            {
              "value": "pants",
              "label": "t:sections.main-product.blocks.collapsible_tab.settings.icon.options__13.label"
            },
            {
              "value": "plane",
              "label": "t:sections.main-product.blocks.collapsible_tab.settings.icon.options__14.label"
            },
            {
              "value": "price_tag",
              "label": "t:sections.main-product.blocks.collapsible_tab.settings.icon.options__15.label"
            },
            {
              "value": "question_mark",
              "label": "t:sections.main-product.blocks.collapsible_tab.settings.icon.options__16.label"
            },
            {
              "value": "return",
              "label": "t:sections.main-product.blocks.collapsible_tab.settings.icon.options__17.label"
            },
            {
              "value": "ruler",
              "label": "t:sections.main-product.blocks.collapsible_tab.settings.icon.options__18.label"
            },
            {
              "value": "shirt",
              "label": "t:sections.main-product.blocks.collapsible_tab.settings.icon.options__19.label"
            },
            {
              "value": "shoe",
              "label": "t:sections.main-product.blocks.collapsible_tab.settings.icon.options__20.label"
            },
            {
              "value": "silhouette",
              "label": "t:sections.main-product.blocks.collapsible_tab.settings.icon.options__21.label"
            },
            {
              "value": "star",
              "label": "t:sections.main-product.blocks.collapsible_tab.settings.icon.options__22.label"
            },
            {
              "value": "truck",
              "label": "t:sections.main-product.blocks.collapsible_tab.settings.icon.options__23.label"
            },
            {
              "value": "washing",
              "label": "t:sections.main-product.blocks.collapsible_tab.settings.icon.options__24.label"
            }
          ],
          "default": "check_mark",
          "label": "t:sections.main-product.blocks.collapsible_tab.settings.icon.label"
        },
            {
            "type": "radio",
            "id": "productdesc",
            "label": "Product Description",
            "options": [
                {
                  "label": "Short Description",
                  "value": "shortdesc"
                },
                {
                  "label": "Full Description",
                  "value": "fulldesc"
                }
              ],
              "default": "shortdesc"
            },
            {
              "type": "number",
              "id": "truncatewords_count_handle",
              "label": "Description Word Count",
              "default": 35,
              "info": "If 'Full Description' is selected, then it will be applicable"
            },
            {
              "type": "header",
              "content": "How to use Short Description",
              "info": "Please check the documentation, [click here](https:\/\/themeadora.com\/doc\/product-short-description\/)"
            }
	   ]
    },
    {
      "type": "share",
      "name": "t:sections.main-product.blocks.share.name",
      "limit": 1,
      "settings": [
        {
          "type": "text",
          "id": "share_label",
          "label": "t:sections.main-product.blocks.share.settings.text.label",
          "default": "Share"
        },
		 {
          "type": "checkbox",
          "id": "share_link",
          "default": true,
          "label": "Enable share link"
        },
		{
          "type": "checkbox",
          "id": "facebook_share",
          "default": true,
          "label": "Enable facebook share link"
        },
		{
          "type": "checkbox",
          "id": "twitter_share",
          "default": true,
          "label": "Enable twitter share link"
        },
		{
          "type": "checkbox",
          "id": "pinterest_share",
          "default": true,
          "label": "Enable pinterest share link"
        },
        {
          "type": "paragraph",
          "content": "t:sections.main-product.blocks.share.settings.featured_image_info.content"
        },
        {
          "type": "paragraph",
          "content": "t:sections.main-product.blocks.share.settings.title_info.content"
        }
      ]
    },
    {
      "type": "custom_liquid",
      "name": "t:sections.main-product.blocks.custom_liquid.name",
      "settings": [
        {
          "type": "liquid",
          "id": "custom_liquid",
          "label": "t:sections.main-product.blocks.custom_liquid.settings.custom_liquid.label",
          "info": "t:sections.main-product.blocks.custom_liquid.settings.custom_liquid.info"
        }
      ]
    },
    {
      "type": "collapsible_tab",
      "name": "t:sections.main-product.blocks.collapsible_tab.name",
      "settings": [
        {
          "type": "text",
          "id": "heading",
          "default": "Collapsible tab",
          "info": "t:sections.main-product.blocks.collapsible_tab.settings.heading.info",
          "label": "t:sections.main-product.blocks.collapsible_tab.settings.heading.label"
        },
        {
          "type": "richtext",
          "id": "content",
          "label": "t:sections.main-product.blocks.collapsible_tab.settings.content.label"
        },
        {
          "type": "page",
          "id": "page",
          "label": "t:sections.main-product.blocks.collapsible_tab.settings.page.label"
        },
        {
          "type": "select",
          "id": "icon",
          "options": [
            {
              "value": "none",
              "label": "t:sections.main-product.blocks.collapsible_tab.settings.icon.options__1.label"
            },
            {
              "value": "box",
              "label": "t:sections.main-product.blocks.collapsible_tab.settings.icon.options__2.label"
            },
            {
              "value": "chat_bubble",
              "label": "t:sections.main-product.blocks.collapsible_tab.settings.icon.options__3.label"
            },
            {
              "value": "check_mark",
              "label": "t:sections.main-product.blocks.collapsible_tab.settings.icon.options__4.label"
            },
            {
              "value": "dryer",
              "label": "t:sections.main-product.blocks.collapsible_tab.settings.icon.options__5.label"
            },
            {
              "value": "eye",
              "label": "t:sections.main-product.blocks.collapsible_tab.settings.icon.options__6.label"
            },
            {
              "value": "heart",
              "label": "t:sections.main-product.blocks.collapsible_tab.settings.icon.options__7.label"
            },
            {
              "value": "iron",
              "label": "t:sections.main-product.blocks.collapsible_tab.settings.icon.options__8.label"
            },
            {
              "value": "leaf",
              "label": "t:sections.main-product.blocks.collapsible_tab.settings.icon.options__9.label"
            },
            {
              "value": "leather",
              "label": "t:sections.main-product.blocks.collapsible_tab.settings.icon.options__10.label"
            },
            {
              "value": "lock",
              "label": "t:sections.main-product.blocks.collapsible_tab.settings.icon.options__11.label"
            },
            {
              "value": "map_pin",
              "label": "t:sections.main-product.blocks.collapsible_tab.settings.icon.options__12.label"
            },
            {
              "value": "pants",
              "label": "t:sections.main-product.blocks.collapsible_tab.settings.icon.options__13.label"
            },
            {
              "value": "plane",
              "label": "t:sections.main-product.blocks.collapsible_tab.settings.icon.options__14.label"
            },
            {
              "value": "price_tag",
              "label": "t:sections.main-product.blocks.collapsible_tab.settings.icon.options__15.label"
            },
            {
              "value": "question_mark",
              "label": "t:sections.main-product.blocks.collapsible_tab.settings.icon.options__16.label"
            },
            {
              "value": "return",
              "label": "t:sections.main-product.blocks.collapsible_tab.settings.icon.options__17.label"
            },
            {
              "value": "ruler",
              "label": "t:sections.main-product.blocks.collapsible_tab.settings.icon.options__18.label"
            },
            {
              "value": "shirt",
              "label": "t:sections.main-product.blocks.collapsible_tab.settings.icon.options__19.label"
            },
            {
              "value": "shoe",
              "label": "t:sections.main-product.blocks.collapsible_tab.settings.icon.options__20.label"
            },
            {
              "value": "silhouette",
              "label": "t:sections.main-product.blocks.collapsible_tab.settings.icon.options__21.label"
            },
            {
              "value": "star",
              "label": "t:sections.main-product.blocks.collapsible_tab.settings.icon.options__22.label"
            },
            {
              "value": "truck",
              "label": "t:sections.main-product.blocks.collapsible_tab.settings.icon.options__23.label"
            },
            {
              "value": "washing",
              "label": "t:sections.main-product.blocks.collapsible_tab.settings.icon.options__24.label"
            }
          ],
          "default": "check_mark",
          "label": "t:sections.main-product.blocks.collapsible_tab.settings.icon.label"
        }
      ]
    },
    {
      "type": "popup_size_guide",
      "name": "Pop-up size guide",
  	  "limit": 1,
      "settings": [
        {
          "type": "text",
          "id": "size_guide",
          "label": "Size Guide Label",
          "default": "Size Guide"
        },
  		{
          "type": "richtext",
          "id": "content",
          "label": "Popup content"
        },
        {
          "type": "page",
          "id": "sizeguidhandle",
          "label": "Select Page for Size Guide popup",
          "info": "[Create a page](\/admin\/pages\/new)"
        }

      ]
    },
  	{
      "type": "popup_text",
      "name": "Pop-up text",
  	  "limit": 1,
      "settings": [
        {
          "type": "text",
          "id": "popup_label",
          "label": "Pop-up text label",
          "default": "Popup Text"
        },
  		 {
          "type": "richtext",
          "id": "content",
          "label": "Popup content"
        },
        {
          "type": "page",
          "id": "shipping_page_handle",
          "label": "Select Page for text popup",
          "info": "[Create a page](\/admin\/pages\/new)"
        }
      ]
    },
  	{
      "type": "popup_contact_form",
      "name": "Pop-up contact form",
  	  "limit": 1,
      "settings": [
        {
          "type": "text",
          "id": "contact_form_label",
          "label": "Ask about product label",
          "default": "Ask About This product "
        },
        {
          "type": "text",
          "id": "ask_about_prod_title",
          "label": "Contact form label",
          "default": "Have a question?"
        },
        {
          "type": "text",
          "id": "send_btn_text",
          "label": "Submit button",
          "default": "Send"
        },
        {
          "type": "paragraph",
          "content": "Name field"
        },
        {
          "type": "text",
          "id": "name_placeholder",
          "label": "Name placeholder",
          "default": "Name *"
        },
        {
          "type": "paragraph",
          "content": "Email field"
        },
        {
          "type": "text",
          "id": "email_placeholder",
          "label": "Email placeholder",
          "default": "Email *"
        },
        {
          "type": "paragraph",
          "content": "Phone Field"
        },
        {
          "type": "text",
          "id": "phone_placeholder",
          "label": "Phone placeholder",
          "default": "Phone *"
        },
        {
        "type": "paragraph",
          "content": "Link field"
        },
        {
          "type": "text",
          "id": "prod_url_placeholder",
          "label": "Product link placeholder",
          "default": "Reference link *"
        },
        {
          "type": "paragraph",
          "content": "Message body"
        },
        {
          "type": "text",
          "id": "body_placeholder",
          "label": "Message body",
          "default": "Write Message *"
        }
      ]
    },
    {
      "type": "rating",
      "name": "t:sections.main-product.blocks.rating.name",
      "limit": 1,
      "settings": [
        {
          "type": "paragraph",
          "content": "t:sections.main-product.blocks.rating.settings.paragraph.content"
        }
      ]
    }
  ]
}
{% endschema %}
